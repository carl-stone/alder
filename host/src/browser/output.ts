import { notebookUrl } from "./url.js";

type JsonObject = Record<string, unknown>;

interface PendingWidget {
  widget: JsonObject;
  path: readonly string[];
  update: JsonObject | null;
  authoritative: {
    node: HTMLElement;
    widget: JsonObject;
    spec: JsonObject;
    path: readonly string[];
  } | null;
  oneShot: boolean;
  control: HTMLElement;
  failure: unknown | null;
  done: Promise<void>;
  resolveDone(): void;
}

export interface OutputActions {
  widget(name: string, path: readonly string[], update: JsonObject): Promise<unknown>;
  upload(name: string, path: readonly string[], files: readonly File[]): Promise<unknown>;
  lazy(key: string): Promise<unknown>;
  table(request: {
    handle: string;
    offset: number;
    limit: number;
    sortBy: string;
    sortDescending: boolean;
    filter: string;
  }): Promise<unknown>;
  error(error: unknown): void;
  pageSize(): number;
  widgetAvailable(widget: JsonObject): boolean;
}

const MUTABLE_WIDGET_FIELDS = new Set([
  "value", "index", "indices", "selected", "page", "ops", "paused", "dirty",
]);

/** R produces bounded output records; this class owns their DOM projection only. */
export class OutputRenderer {
  private readonly signatures = new WeakMap<Element, string>();
  private readonly structures = new WeakMap<Element, string>();
  private readonly pendingWidgets = new Map<string, PendingWidget>();
  private readonly pendingForms = new Map<string, Promise<void>>();
  private readonly pendingUploads = new Set<Promise<void>>();
  private lastFailure: { error: unknown } | null = null;
  private layoutSequence = 0;

  constructor(private readonly actions: OutputActions) {}

  async flush(): Promise<void> {
    const previousFailure = this.lastFailure;
    while (this.pendingWidgets.size || this.pendingForms.size || this.pendingUploads.size) {
      await Promise.all([
        ...Array.from(this.pendingWidgets.values(), (pending) => pending.done),
        ...this.pendingForms.values(),
        ...this.pendingUploads,
      ]);
    }
    // Fail the action waiting on this input, without replaying an already
    // reported and rolled-back failure at an unrelated later action.
    if (this.lastFailure !== previousFailure) throw this.lastFailure!.error;
  }

  render(container: HTMLElement, outputs: readonly unknown[], progress: unknown | null): void {
    container.classList.add("out-stack");
    const retained = new Set<Element>();
    outputs.forEach((output, index) => {
      this.updateSlot(container, `output-${index}`, output, index, false, retained);
    });
    if (isObject(progress)) {
      this.updateSlot(container, "progress", { kind: "progress", ...progress }, null, true, retained);
    }
    for (const child of Array.from(container.children)) {
      if (child.classList.contains("out-record") && !retained.has(child)) child.remove();
    }
  }

  private updateSlot(
    container: HTMLElement,
    key: string,
    output: unknown,
    index: number | null,
    progress: boolean,
    retained: Set<Element>,
  ): void {
    let slot = Array.from(container.children).find((child) =>
      child.classList.contains("out-record") && (child as HTMLElement).dataset.recordKey === key,
    ) as HTMLElement | undefined;
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "out-record";
      slot.dataset.recordKey = key;
    }
    if (index === null) delete slot.dataset.index;
    else slot.dataset.index = String(index);
    slot.classList.toggle("out-progress", progress);
    const kind = isObject(output) ? string(output.kind) : "";
    const signature = stableJson(output);
    const structure = stableJson(outputStructure(output));
    const hasWidgets = containsWidget(output);
    const canPatch = hasWidgets && slot.dataset.outputKind === kind &&
      this.structures.get(slot) === structure && this.patchWidgets(slot, output);
    if (!canPatch && (this.signatures.get(slot) !== signature || slot.dataset.outputKind !== kind)) {
      slot.replaceChildren();
      this.renderRecord(slot, output);
    }
    this.signatures.set(slot, signature);
    this.structures.set(slot, structure);
    slot.dataset.outputKind = kind;
    retained.add(slot);
    // Re-appending a connected node can blur native controls in Chromium.
    if (slot.parentElement !== container) container.appendChild(slot);
  }

  private renderRecord(container: HTMLElement, value: unknown): void {
    if (!isObject(value)) return;
    const kind = string(value.kind);
    if (kind === "widget") {
      container.appendChild(this.createWidget(value, object(value.spec), []));
      this.patchWidget(container.firstElementChild as HTMLElement, value, object(value.spec), []);
      return;
    }
    if (kind === "text") {
      const pre = element("pre", "value-text", string(value.text));
      container.appendChild(pre);
      if (value.truncated === true) container.appendChild(element("div", "truncation-note", "Output truncated."));
      return;
    }
    if (kind === "table") {
      this.renderTable(container, value);
      return;
    }
    if (kind === "image") {
      const image = document.createElement("img");
      image.className = "plot";
      image.alt = string(value.alt_text) || "Plot";
      image.src = artifactUrl(value.artifact);
      container.appendChild(image);
      return;
    }
    if (kind === "html") {
      const frame = document.createElement("iframe");
      frame.className = "html-widget";
      frame.title = string(value.alt_text) || "HTML widget";
      frame.sandbox.add("allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.src = artifactUrl(value.artifact);
      const height = number(value.height);
      if (height !== null) frame.height = String(Math.max(100, height));
      container.appendChild(frame);
      return;
    }
    if (kind === "markdown") {
      const markdown = element("div", "markdown-output");
      // The R rendering service sanitizes this exact field before it enters
      // authoritative host state. No client source is interpolated here.
      markdown.innerHTML = string(value.html);
      container.appendChild(markdown);
      return;
    }
    if (kind === "media") {
      const mediaKind = string(value.media_type) || "image";
      let media: HTMLMediaElement | HTMLIFrameElement | HTMLImageElement;
      if (mediaKind === "audio") {
        media = document.createElement("audio");
        media.controls = true;
      } else if (mediaKind === "video") {
        media = document.createElement("video");
        media.controls = true;
      } else if (mediaKind === "pdf") {
        media = document.createElement("iframe");
        media.title = string(value.alt) || "PDF";
        media.className = "media-pdf";
      } else {
        media = document.createElement("img");
        media.alt = string(value.alt);
      }
      media.classList.add("out-media");
      media.src = artifactUrl(value.artifact);
      container.appendChild(media);
      return;
    }
    if (kind === "layout") {
      this.renderLayout(container, value);
      return;
    }
    if (kind === "lazy") {
      if (value.child) this.renderRecord(container, value.child);
      else {
        const button = element("button", "out-lazy", string(value.label) || "Show") as HTMLButtonElement;
        button.type = "button";
        button.addEventListener("click", () => {
          button.disabled = true;
          void this.actions.lazy(string(value.key)).catch((error) => {
            button.disabled = false;
            container.appendChild(element("div", "output-error", message(error, "Lazy output failed")));
            this.actions.error(error);
          });
        });
        container.appendChild(button);
      }
      return;
    }
    if (kind === "progress") {
      const row = element("div", "progress-row");
      const progress = document.createElement("progress");
      const total = number(value.total);
      if (total !== null) progress.max = total;
      progress.value = number(value.value) ?? 0;
      row.append(progress, element("div", "progress-label", string(value.label)));
      container.appendChild(row);
      return;
    }
    if (kind === "error") {
      container.appendChild(element("div", "output-error", string(value.message) || "Evaluation failed"));
    }
  }

  private renderLayout(container: HTMLElement, output: JsonObject): void {
    const layout = string(output.layout) || "vstack";
    const wrap = element("div", `out-layout out-${safeClass(layout)}`);
    const attrs = object(output.attrs);
    if (layout === "callout") wrap.classList.add(`out-callout-${safeClass(string(attrs.variant) || "info")}`);
    const children = array(output.children);
    const slots = children.map((child, index) => {
      const slot = element("div", "out-layout-child");
      slot.dataset.index = String(index);
      this.renderRecord(slot, child);
      wrap.appendChild(slot);
      return slot;
    });
    if ((layout === "tabs" || layout === "accordion") && slots.length) {
      const titles = array(attrs.titles);
      const prefix = `alder-output-${layout}-${++this.layoutSequence}`;
      const controls = element("div", layout === "tabs" ? "out-tabs" : "out-accordion");
      if (layout === "tabs") {
        controls.setAttribute("role", "tablist");
        controls.setAttribute("aria-label", "Output tabs");
      }
      const buttons: HTMLButtonElement[] = [];
      const select = (selected: number): void => {
        slots.forEach((slot, index) => {
          slot.hidden = layout === "tabs" ? index !== selected : index !== selected || !slot.hidden;
          const button = buttons[index];
          if (!button) return;
          if (layout === "tabs") {
            button.setAttribute("aria-selected", String(index === selected));
            button.tabIndex = index === selected ? 0 : -1;
          } else button.setAttribute("aria-expanded", String(!slot.hidden));
        });
      };
      slots.forEach((slot, index) => {
        const button = element("button", layout === "tabs" ? "out-tab-btn" : "out-accordion-btn",
          string(titles[index]) || `Item ${index + 1}`) as HTMLButtonElement;
        button.type = "button";
        button.id = `${prefix}-control-${index}`;
        slot.id = `${prefix}-panel-${index}`;
        button.setAttribute("aria-controls", slot.id);
        slot.setAttribute("aria-labelledby", button.id);
        if (layout === "tabs") {
          button.setAttribute("role", "tab");
          slot.setAttribute("role", "tabpanel");
        } else slot.setAttribute("role", "region");
        button.addEventListener("click", () => select(index));
        button.addEventListener("keydown", (event) => {
          if (layout !== "tabs") return;
          const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
            event.key === "ArrowRight" ? (index + 1) % buttons.length :
              event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : null;
          if (target === null) return;
          event.preventDefault();
          buttons[target]?.click();
          buttons[target]?.focus();
        });
        buttons.push(button);
        controls.appendChild(button);
      });
      wrap.prepend(controls);
      slots.forEach((slot, index) => { slot.hidden = layout === "tabs" ? index !== 0 : true; });
      buttons.forEach((button, index) => {
        if (layout === "tabs") {
          button.setAttribute("aria-selected", String(index === 0));
          button.tabIndex = index === 0 ? 0 : -1;
        } else button.setAttribute("aria-expanded", "false");
      });
    }
    container.appendChild(wrap);
  }

  private renderTable(container: HTMLElement, output: JsonObject): void {
    const page = object(output.page);
    const columns = list(page.columns ?? output.columns).map(string);
    const rows = array(page.preview ?? output.preview);
    const offset = number(page.offset) ?? 0;
    const configured = this.actions.pageSize();
    const limit = Number.isInteger(configured) && configured >= 5 ? configured : number(page.limit) ?? Math.max(1, rows.length || 25);
    const total = number(page.nrow) ?? number(output.nrow) ?? 0;
    const sortBy = string(page.sort_by);
    const sortDescending = page.sort_desc === true;
    const filter = string(page.filter);
    const handle = string(output.handle);
    const request = (update: Partial<Parameters<OutputActions["table"]>[0]>, control: HTMLButtonElement | HTMLInputElement): void => {
      control.disabled = true;
      void this.actions.table({ handle, offset, limit, sortBy, sortDescending, filter, ...update })
        .catch((error) => { control.disabled = false; this.actions.error(error); });
    };
    const wrap = element("div", "table-preview");
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    columns.forEach((column) => {
      const th = document.createElement("th");
      const sort = element("button", "table-sort", `${column}${sortBy === column ? sortDescending ? " (desc)" : " (asc)" : ""}`) as HTMLButtonElement;
      sort.type = "button";
      sort.dataset.role = "table-sort";
      sort.dataset.column = column;
      sort.addEventListener("click", () => request({ sortBy: column, sortDescending: sortBy === column ? !sortDescending : false }, sort));
      th.appendChild(sort);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    rows.forEach((raw) => {
      const row = document.createElement("tr");
      const values = Array.isArray(raw) ? raw : isObject(raw) ? columns.map((column) => raw[column]) : [];
      columns.forEach((_column, index) => row.appendChild(element("td", "", string(values[index]))));
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    container.appendChild(wrap);

    const toolbar = element("div", "table-toolbar");
    const input = document.createElement("input");
    input.type = "search";
    input.className = "table-filter";
    input.dataset.role = "table-filter";
    input.placeholder = "Filter text columns";
    input.setAttribute("aria-label", "Filter table");
    input.value = filter;
    let timer: number | null = null;
    input.addEventListener("input", () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => request({ offset: 0, filter: input.value }, input), 250);
    });
    toolbar.appendChild(input);
    const copy = element("button", "table-copy", "Copy TSV") as HTMLButtonElement;
    copy.type = "button";
    copy.dataset.role = "table-copy";
    copy.addEventListener("click", () => void copyTsv(columns, rows).then(() => {
      copy.textContent = "Copied";
      window.setTimeout(() => { copy.textContent = "Copy TSV"; }, 1_000);
    }).catch((error) => this.actions.error(error)));
    toolbar.appendChild(copy);
    container.appendChild(toolbar);

    const pager = element("div", "table-pager");
    const previous = element("button", "", "Prev") as HTMLButtonElement;
    previous.type = "button";
    previous.disabled = offset <= 0;
    previous.addEventListener("click", () => request({ offset: Math.max(0, offset - limit) }, previous));
    const next = element("button", "", "Next") as HTMLButtonElement;
    next.type = "button";
    next.disabled = offset + rows.length >= total;
    next.addEventListener("click", () => request({ offset: offset + limit }, next));
    pager.append(previous, element("div", "table-page-label", `${total === 0 ? 0 : offset + 1}..${Math.min(total, offset + rows.length)} of ${total}`), next);
    container.appendChild(pager);
    container.appendChild(element("div", "table-meta", `${number(output.nrow) ?? total} rows × ${number(output.ncol) ?? columns.length} columns`));
    const truncated = [output.truncated_rows ? "rows truncated" : "", output.truncated_columns ? "columns truncated" : ""].filter(Boolean);
    if (truncated.length) container.appendChild(element("div", "truncation-note", truncated.join("; ")));
  }

  private createWidget(widget: JsonObject, spec: JsonObject, path: readonly string[]): HTMLElement {
    const kind = string(spec.kind);
    const node = element("div", ["array", "dictionary", "form"].includes(kind) ? "widget-group" : "widget-container");
    node.dataset.widgetKey = widgetKey(widget, kind, path);
    node.dataset.kind = kind;
    node.dataset.name = string(widget.name);
    node.dataset.owner = string(widget.owner);
    node.dataset.path = JSON.stringify(path);
    if (kind === "array" || kind === "dictionary") {
      this.appendLabel(node, spec, null);
      for (const child of array(spec.children).filter(isObject)) {
        node.appendChild(this.createWidget(widget, child, [...path, string(child.name)]));
      }
      return node;
    }
    if (kind === "form") {
      this.appendLabel(node, spec, null);
      node.appendChild(this.createWidget(widget, object(spec.child), path));
      const submit = this.control(document.createElement("button"), widget, spec, kind, path);
      submit.type = "button";
      submit.textContent = string(spec.submit_label) || "Submit";
      submit.dataset.formSubmit = "true";
      submit.addEventListener("click", () => this.submitForm(node, widget, spec, path, submit));
      node.appendChild(submit);
      return node;
    }
    if (kind === "table" || kind === "dataframe") {
      this.appendLabel(node, spec, null);
      this.buildWidgetTable(node, widget, spec, kind, path);
      return node;
    }
    if (kind === "radio") {
      const fieldset = document.createElement("fieldset");
      this.appendLabel(fieldset, spec, null, "legend");
      array(spec.choices).forEach((choice, index) => {
        const label = document.createElement("label");
        const input = this.control(document.createElement("input"), widget, spec, kind, path);
        input.type = "radio";
        input.name = `${string(widget.name)}-${path.join("-")}`;
        input.value = String(index + 1);
        input.addEventListener("change", () => this.sendWidget(widget, path, { index: index + 1 }, input));
        label.append(input, document.createTextNode(string(choice)));
        fieldset.appendChild(label);
      });
      node.appendChild(fieldset);
      return node;
    }
    let control: HTMLElement;
    if (kind === "dropdown" || kind === "multiselect") {
      const select = document.createElement("select");
      select.multiple = kind === "multiselect";
      array(spec.choices).forEach((choice, index) => {
        const option = document.createElement("option");
        option.value = String(index + 1);
        option.textContent = string(choice);
        select.appendChild(option);
      });
      control = this.control(select, widget, spec, kind, path);
    } else if (["run_button", "button", "refresh"].includes(kind)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = string(spec.label) || (kind === "run_button" ? "Run" : kind);
      control = this.control(button, widget, spec, kind, path);
    } else if (kind === "text_area" || kind === "code_editor") {
      const area = document.createElement("textarea");
      const rows = number(spec.rows);
      if (rows !== null) area.rows = rows;
      control = this.control(area, widget, spec, kind, path);
    } else if (kind === "range_slider" || kind === "date_range") {
      control = document.createElement("div");
      [0, 1].forEach((part) => {
        const input = this.control(document.createElement("input"), widget, spec, kind, path);
        input.type = kind === "range_slider" ? "range" : "date";
        input.dataset.rangePart = String(part);
        control.appendChild(input);
      });
    } else {
      const input = document.createElement("input");
      input.type = kind === "file" ? "file" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" :
        kind === "checkbox" || kind === "switch" ? "checkbox" : kind === "slider" ? "range" : kind === "number" ? "number" : "text";
      if (kind === "file") {
        input.multiple = spec.multiple === true;
        if (spec.accept) input.accept = Array.isArray(spec.accept) ? spec.accept.map(string).join(",") : string(spec.accept);
      }
      control = this.control(input, widget, spec, kind, path);
    }
    const labelled = control.matches("input,select,textarea,button") ? control : null;
    this.appendLabel(node, spec, labelled);
    node.appendChild(control);
    if (kind === "datetime") {
      const timezone = element("span", "widget-timezone", "UTC");
      timezone.id = `${labelled?.id ?? "widget"}-timezone`;
      labelled?.setAttribute("aria-describedby", timezone.id);
      labelled?.setAttribute("title", "UTC date and time");
      node.appendChild(timezone);
    }
    if (kind === "slider" || kind === "number") node.appendChild(element("span", "widget-value"));
    this.bindWidgetControls(node, widget, kind, path);
    return node;
  }

  private bindWidgetControls(node: HTMLElement, widget: JsonObject, kind: string, path: readonly string[]): void {
    const controls = this.widgetControls(node, kind, path);
    const send = (update: JsonObject, control: HTMLElement): void => {
      void this.sendWidget(widget, path, update, control);
    };
    for (const control of controls) {
      if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement)) continue;
      if (kind === "run_button") control.addEventListener("click", () => send({ value: true }, control));
      else if (kind === "button" || kind === "refresh") control.addEventListener("click", () => {
        const current = Number(control.dataset.value ?? 0);
        send({ value: Number.isFinite(current) ? Math.floor(current) + 1 : 1, ...(kind === "refresh" ? { paused: false } : {}) }, control);
      });
      else if (kind === "file" && control instanceof HTMLInputElement) control.addEventListener("change", () => {
        control.disabled = true;
        let upload!: Promise<void>;
        upload = this.actions.upload(string(widget.name), path, Array.from(control.files ?? []))
          .then(() => undefined, (error) => {
            this.lastFailure = { error };
            this.actions.error(error);
          }).finally(() => {
            control.disabled = false;
            this.pendingUploads.delete(upload);
          });
        this.pendingUploads.add(upload);
      });
      else {
        const event = ["slider", "number", "range_slider", "text_input", "text_area", "code_editor"].includes(kind) ? "input" : "change";
        control.addEventListener(event, () => {
          if (kind === "dropdown" || kind === "radio") send({ index: Number(control.value) }, control);
          else if (kind === "multiselect" && control instanceof HTMLSelectElement) send({ indices: Array.from(control.selectedOptions).map((option) => Number(option.value)) }, control);
          else if (kind === "checkbox" || kind === "switch") send({ value: (control as HTMLInputElement).checked }, control);
          else if (kind === "slider" || kind === "number") {
            const value = Number(control.value);
            const label = node.querySelector(".widget-value");
            if (label) label.textContent = String(value);
            if (Number.isFinite(value)) send({ value }, control);
          } else if (kind === "range_slider") send({ value: controls.map((item) => Number((item as HTMLInputElement).value)) }, control);
          else if (kind === "date_range") send({ value: controls.map((item) => (item as HTMLInputElement).value) }, control);
          else if (kind === "datetime") send({ value: datetimeWire(control.value) }, control);
          else send({ value: control.value }, control);
        });
      }
    }
  }

  private sendWidget(widget: JsonObject, path: readonly string[], update: JsonObject, control: HTMLElement): Promise<void> {
    const key = widgetKey(widget, string(control.dataset.kind), path);
    const oneShot = ["run_button", "button", "refresh", "form"].includes(string(control.dataset.kind));
    const current = this.pendingWidgets.get(key);
    if (current) {
      // Continuous native controls stay responsive. Preserve only the newest
      // value while the exact prior widget operation and causal reset settle.
      if (!current.oneShot) current.update = update;
      return current.done;
    }
    if (oneShot) control.setAttribute("disabled", "");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const pending: PendingWidget = {
      widget, path: [...path], update, authoritative: null, oneShot, control, failure: null, done, resolveDone,
    };
    this.pendingWidgets.set(key, pending);
    void (async () => {
      try {
        while (pending.update) {
          const next = pending.update;
          pending.update = null;
          await this.actions.widget(string(pending.widget.name), pending.path, next);
        }
      } catch (error) {
        pending.failure = error;
        this.lastFailure = { error };
        this.actions.error(error);
      } finally {
        this.pendingWidgets.delete(key);
        if (pending.failure !== null && pending.authoritative) {
          const { node, widget: authoritativeWidget, spec, path: authoritativePath } = pending.authoritative;
          this.patchWidget(node, authoritativeWidget, spec, authoritativePath, true);
        }
        if (oneShot) control.removeAttribute("disabled");
        pending.resolveDone();
      }
    })();
    return done;
  }

  private submitForm(node: HTMLElement, widget: JsonObject, spec: JsonObject, path: readonly string[], control: HTMLButtonElement): void {
    const key = widgetKey(widget, "form", path);
    if (this.pendingForms.has(key)) return;
    control.disabled = true;
    for (const child of Array.from(node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("[data-role=widget]"))) {
      child.disabled = true;
    }
    let request!: Promise<void>;
    request = (async () => {
      await this.flushWidgetSubtree(string(widget.name), path);
      await this.sendWidget(widget, path, { submit: true }, control);
    })().catch(() => {
      // The originating widget operation reports its failure to any action
      // currently waiting for these inputs.
    }).finally(() => {
      if (this.pendingForms.get(key) === request) this.pendingForms.delete(key);
      this.patchWidget(node, widget, spec, path);
    });
    this.pendingForms.set(key, request);
  }

  private async flushWidgetSubtree(name: string, path: readonly string[]): Promise<void> {
    for (;;) {
      const pending = Array.from(this.pendingWidgets.values()).filter((operation) =>
        string(operation.widget.name) === name && path.every((part, index) => operation.path[index] === part));
      if (!pending.length) return;
      await Promise.all(pending.map((operation) => operation.done));
      const failed = pending.find((operation) => operation.failure !== null);
      if (failed) throw failed.failure;
    }
  }

  private buildWidgetTable(node: HTMLElement, widget: JsonObject, spec: JsonObject, kind: string, path: readonly string[]): void {
    const page = object(spec.page);
    const columns = list(page.columns).map(string);
    const selected = new Set(array(spec.selected).map(Number));
    const table = document.createElement("table");
    table.className = "widget-table";
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    if (kind === "table") row.appendChild(document.createElement("th"));
    columns.forEach((column) => row.appendChild(element("th", "", column)));
    head.appendChild(row);
    table.appendChild(head);
    const body = document.createElement("tbody");
    array(page.preview).forEach((raw, index) => {
      const tr = document.createElement("tr");
      if (kind === "table") {
        const td = document.createElement("td");
        const input = this.control(document.createElement("input"), widget, spec, kind, path);
        input.type = "checkbox";
        input.value = String(index + 1);
        input.checked = selected.has(index + 1);
        input.addEventListener("change", () => {
          const values = this.widgetControls(node, kind, path)
            .filter((entry): entry is HTMLInputElement => entry instanceof HTMLInputElement && entry.checked)
            .map((entry) => Number(entry.value));
          this.sendWidget(widget, path, { selected: values }, input);
        });
        td.appendChild(input);
        tr.appendChild(td);
      }
      array(raw).forEach((value) => tr.appendChild(element("td", "", string(value))));
      body.appendChild(tr);
    });
    table.appendChild(body);
    node.appendChild(table);
  }

  private patchWidgets(container: HTMLElement, output: unknown): boolean {
    const widgets: JsonObject[] = [];
    visitWidgets(output, (widget) => widgets.push(widget));
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-widget-key]"));
    const used = new Set<HTMLElement>();
    for (const widget of widgets) {
      const spec = object(widget.spec);
      const key = widgetKey(widget, string(spec.kind), []);
      const row = rows.find((candidate) => !used.has(candidate) && candidate.dataset.widgetKey === key);
      if (!row) return false;
      used.add(row);
      this.patchWidget(row, widget, spec, []);
    }
    return true;
  }

  private patchWidget(
    node: HTMLElement,
    widget: JsonObject,
    spec: JsonObject,
    path: readonly string[],
    force = false,
  ): void {
    const kind = string(spec.kind);
    const key = widgetKey(widget, kind, path);
    const operation = this.pendingWidgets.get(key);
    const pending = operation !== undefined;
    if (operation) operation.authoritative = { node, widget, spec, path: [...path] };
    const current = this.actions.widgetAvailable(widget);
    node.dataset.current = String(current);
    node.dataset.pending = String(pending);
    node.toggleAttribute("aria-busy", pending);
    if (kind === "array" || kind === "dictionary") {
      for (const child of array(spec.children).filter(isObject)) {
        const childPath = [...path, string(child.name)];
        const found = Array.from(node.children).find((item) => (item as HTMLElement).dataset?.widgetKey === widgetKey(widget, string(child.kind), childPath));
        if (found instanceof HTMLElement) this.patchWidget(found, widget, child, childPath, force);
      }
      return;
    }
    if (kind === "form") {
      const child = object(spec.child);
      const found = Array.from(node.children).find((item) => (item as HTMLElement).dataset?.widgetKey === widgetKey(widget, string(child.kind), path));
      if (found instanceof HTMLElement) this.patchWidget(found, widget, child, path, force);
      const submit = node.querySelector<HTMLButtonElement>("[data-form-submit=true]");
      const submitting = this.pendingForms.has(key);
      if (submit) submit.disabled = !current || pending || submitting || spec.dirty !== true;
      if (submitting && found instanceof HTMLElement) {
        for (const child of Array.from(found.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("[data-role=widget]"))) {
          child.disabled = true;
        }
      }
      return;
    }
    if ((kind === "table" || kind === "dataframe") && (force || !node.contains(document.activeElement) && !pending)) {
      const replacement = this.createWidget(widget, spec, path);
      node.replaceChildren(...Array.from(replacement.childNodes));
      return;
    }
    const controls = this.widgetControls(node, kind, path);
    const oneShot = ["run_button", "button", "refresh", "file"].includes(kind);
    controls.forEach((control) => {
      (control as HTMLInputElement).disabled = !current || pending && oneShot;
      if (spec.value !== undefined && !Array.isArray(spec.value)) control.dataset.value = string(spec.value);
    });
    if (!force && (node.contains(document.activeElement) || pending)) return;
    const control = controls[0] as HTMLInputElement | HTMLSelectElement | undefined;
    if (!control) return;
    if (kind === "dropdown") control.value = String(Number.isInteger(spec.index) ? spec.index : 1);
    else if (kind === "multiselect" && control instanceof HTMLSelectElement) {
      const selected = new Set(array(spec.indices).map(Number));
      Array.from(control.options).forEach((option) => { option.selected = selected.has(Number(option.value)); });
    } else if (kind === "radio") {
      const selected = Number.isInteger(spec.index) ? Number(spec.index) : 1;
      controls.forEach((item) => { (item as HTMLInputElement).checked = Number((item as HTMLInputElement).value) === selected; });
    } else if (kind === "checkbox" || kind === "switch") (control as HTMLInputElement).checked = spec.value === true;
    else if (kind === "range_slider" || kind === "date_range") {
      const values = array(spec.value);
      controls.forEach((item, index) => this.patchBounded(item as HTMLInputElement, spec, values[index], kind === "date_range"));
    } else if (kind === "datetime") {
      this.patchBounded(control as HTMLInputElement, spec, spec.value, true, datetimeLocal);
      (control as HTMLInputElement).step = "1";
    }
    else if (kind === "date") this.patchBounded(control as HTMLInputElement, spec, spec.value, true);
    else if (kind === "file") { /* native file values cannot be restored */ }
    else if (kind === "slider" || kind === "number") this.patchBounded(control as HTMLInputElement, spec, array(spec.value).length ? array(spec.value)[0] : spec.value);
    else if (spec.value !== undefined) control.value = string(array(spec.value).length ? array(spec.value)[0] : spec.value);
    if (kind === "slider" || kind === "number") {
      const label = node.querySelector(".widget-value");
      if (label) label.textContent = control.value;
    }
  }

  private patchBounded(
    control: HTMLInputElement,
    spec: JsonObject,
    value: unknown,
    noStep = false,
    convert: (input: unknown) => string = string,
  ): void {
    for (const field of ["min", "max"] as const) {
      if (spec[field] == null) control.removeAttribute(field);
      else control[field] = convert(spec[field]);
    }
    if (!noStep && spec.step != null) control.step = string(spec.step);
    else if (!noStep) control.removeAttribute("step");
    control.value = convert(value);
  }

  private widgetControls(node: HTMLElement, kind: string, path: readonly string[]): HTMLElement[] {
    const encoded = JSON.stringify(path);
    return Array.from(node.querySelectorAll<HTMLElement>("[data-role=widget]")).filter((item) =>
      item.dataset.kind === kind && item.dataset.path === encoded,
    );
  }

  private control<T extends HTMLElement>(control: T, widget: JsonObject, _spec: JsonObject, kind: string, path: readonly string[]): T {
    control.dataset.role = "widget";
    control.dataset.name = string(widget.name);
    control.dataset.kind = kind;
    control.dataset.owner = string(widget.owner);
    control.dataset.path = JSON.stringify(path);
    control.id = `widget-${safePart(widget.owner)}-${safePart(kind)}${path.length ? `-${safePart(path.join("-"))}` : ""}`;
    return control;
  }

  private appendLabel(parent: HTMLElement, spec: JsonObject, control: HTMLElement | null, tag: "label" | "legend" = "label"): void {
    const labelText = string(spec.label);
    if (!labelText) return;
    const label = document.createElement(tag);
    label.dataset.role = "widget-label";
    label.textContent = labelText;
    if (tag === "label" && control) (label as HTMLLabelElement).htmlFor = control.id;
    parent.appendChild(label);
  }
}

function outputStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputStructure);
  if (!isObject(value)) return value;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (value.kind === "widget" && ["commit_token", "operation", "operations"].includes(key)) continue;
    if (value.kind === "widget" && key === "spec") output[key] = widgetStructure(item);
    else output[key] = outputStructure(item);
  }
  return output;
}

function widgetStructure(value: unknown): unknown {
  if (!isObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (MUTABLE_WIDGET_FIELDS.has(key)) continue;
    result[key] = key === "children" && Array.isArray(item) ? item.map(widgetStructure) : key === "child" ? widgetStructure(item) : item;
  }
  return result;
}

function containsWidget(value: unknown): boolean {
  let found = false;
  visitWidgets(value, () => { found = true; });
  return found;
}

function visitWidgets(value: unknown, visit: (widget: JsonObject) => void): void {
  if (!isObject(value)) return;
  if (value.kind === "widget") visit(value);
  else if (value.kind === "layout") array(value.children).forEach((child) => visitWidgets(child, visit));
  else if (value.kind === "lazy") visitWidgets(value.child, visit);
}

function widgetKey(widget: JsonObject, kind: string, path: readonly string[]): string {
  return `${string(widget.name)}\0${kind}\0${path.join("\u0001")}`;
}

function artifactUrl(value: unknown): string {
  return notebookUrl(`/plot/${encodeURIComponent(string(value))}`);
}

function safePart(value: unknown): string {
  return encodeURIComponent(string(value)).replaceAll("%", "_");
}

function safeClass(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function datetimeLocal(value: unknown): string {
  const text = string(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text) ? text.slice(0, -1) : "";
}

function datetimeWire(value: unknown): string {
  let text = string(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) text += ":00";
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ? `${text}Z` : text;
}

async function copyTsv(columns: readonly string[], rows: readonly unknown[]): Promise<void> {
  const text = [columns.join("\t"), ...rows.map((raw) => {
    const values = Array.isArray(raw) ? raw : isObject(raw) ? columns.map((column) => raw[column]) : [];
    return values.map(string).join("\t");
  })].join("\n");
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(area);
  area.select();
  if (!document.execCommand("copy")) throw new Error("browser rejected clipboard copy");
  area.remove();
}

function stableJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject { return isObject(value) ? value : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function list(value: unknown): unknown[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function string(value: unknown): string { return value == null ? "" : String(value); }
function number(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
