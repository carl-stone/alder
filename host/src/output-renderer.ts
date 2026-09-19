import { OUTPUT_CHUNK_BYTES, type ArtifactHandle, type HostCellState, type OutputRecord } from "./protocol.js";

type JsonObject = Record<string, unknown>;
type WidgetControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
export interface WidgetOrigin {
  owner: string;
  revision: number;
  outputId: string;
  outputGeneration: number;
  kernelEpoch: string;
}

interface PendingWidget {
  widget: JsonObject;
  origin: WidgetOrigin;
  path: readonly string[];
  update: JsonObject | null;
  authoritative: {
    node: HTMLElement;
    widget: JsonObject;
    spec: JsonObject;
    path: readonly string[];
  } | null;
  oneShot: boolean;
  control: WidgetControl;
  failure: unknown | null;
  done: Promise<void>;
  resolveDone(): void;
}
export interface OutputActions {
  widget(name: string, path: readonly string[], update: JsonObject, origin: WidgetOrigin): Promise<unknown>;
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

export type OutputArtifactSource =
  | { kind: "url"; url: string }
  | { kind: "html"; html: string };

type OutputRendererBaseOptions = {
  document: Document;
  resolveArtifact: (descriptor: ArtifactHandle) => Promise<OutputArtifactSource>;
};

export type OutputRendererOptions = OutputRendererBaseOptions &
  ({ mode: "interactive"; actions: OutputActions } | { mode: "static" });

const MUTABLE_WIDGET_FIELDS = new Set([
  "value", "index", "indices", "selected", "page", "ops", "paused", "dirty",
]);
/** R produces bounded output records; this class owns their DOM projection only. */
export class OutputRenderer {
  private readonly signatures = new WeakMap<Element, string>();
  private readonly structures = new WeakMap<Element, string>();
  private readonly widgetOrigins = new WeakMap<JsonObject, WidgetOrigin>();
  private readonly controlOrigins = new WeakMap<WidgetControl, WidgetOrigin>();
  private readonly pendingWidgets = new Map<string, PendingWidget>();
  private readonly pendingForms = new Map<string, Promise<void>>();
  private readonly pendingUploads = new Set<Promise<void>>();
  private readonly pendingArtifacts = new Set<Promise<void>>();
  private artifactFailure: unknown | null = null;
  private lastFailure: { error: unknown } | null = null;
  private layoutSequence = 0;
  private readonly document: Document;
  private readonly mode: OutputRendererOptions["mode"];
  private readonly actions: OutputActions | null;
  private readonly resolveArtifact: (descriptor: ArtifactHandle) => Promise<OutputArtifactSource>;
  constructor(options: OutputRendererOptions) {
    this.document = options.document;
    this.mode = options.mode;
    this.actions = options.mode === "interactive" ? options.actions : null;
    this.resolveArtifact = options.resolveArtifact;
  }
  private interactiveActions(): OutputActions {
    if (this.actions === null) throw new Error("interactive output actions are unavailable in static mode");
    return this.actions;
  }

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

  async flushArtifacts(): Promise<void> {
    // Artifact tasks always settle internally, so drain every task before
    // surfacing the first static materialization failure.
    while (this.pendingArtifacts.size) await Promise.all([...this.pendingArtifacts]);
    const failure = this.artifactFailure;
    this.artifactFailure = null;
    if (this.mode === "static" && failure !== null) throw failure;
  }

  render(container: HTMLElement, outputs: readonly OutputRecord[], progress: HostCellState["progress"]): void {
    container.classList.add("out-stack");
    const retained = new Set<Element>();
    outputs.forEach((output, index) => {
      this.updateSlot(container, `output-${index}`, output, index, false, retained);
    });
    if (isObject(progress)) {
      this.updateProgressSlot(container, "progress", progress, retained);
    }
    for (const child of Array.from(container.children)) {
      if (child.classList.contains("out-record") && !retained.has(child)) child.remove();
    }
  }
  private updateSlot(
    container: HTMLElement,
    key: string,
    output: OutputRecord,
    index: number,
    progress: boolean,
    retained: Set<Element>,
  ): void {
    const value = outputData(output);
    if (output.kernelEpoch !== null) {
      visitWidgets(value, (widget) => this.widgetOrigins.set(widget, {
        owner: output.cellId,
        revision: output.revision,
        outputId: output.id,
        outputGeneration: output.generation ?? 0,
        kernelEpoch: output.kernelEpoch!,
      }));
    }
    this.updateValueSlot(container, key, value, index, progress, retained, stableJson(output));
  }

  private updateProgressSlot(
    container: HTMLElement,
    key: string,
    progress: JsonObject,
    retained: Set<Element>,
  ): void {
    this.updateValueSlot(container, key, { kind: "progress", ...progress }, null, true, retained, stableJson(progress));
  }

  private updateValueSlot(
    container: HTMLElement,
    key: string,
    value: unknown,
    index: number | null,
    progress: boolean,
    retained: Set<Element>,
    signature: string,
  ): void {
    let slot = Array.from(container.children).find((child): child is HTMLElement =>
      isElement(child) && child.classList.contains("out-record") && child.dataset.recordKey === key,
    );
    if (!slot) {
      slot = this.document.createElement("div");
      slot.className = "out-record";
      slot.dataset.recordKey = key;
    }
    if (index === null) delete slot.dataset.index;
    else slot.dataset.index = String(index);
    slot.classList.toggle("out-progress", progress);
    const kind = isObject(value) ? string(value.kind) : "";
    const structure = stableJson(outputStructure(value));
    const hasWidgets = containsWidget(value);
    const canPatch = this.mode === "interactive" && hasWidgets && slot.dataset.outputKind === kind &&
      this.structures.get(slot) === structure && this.patchWidgets(slot, value);
    if (!canPatch && (this.signatures.get(slot) !== signature || slot.dataset.outputKind !== kind)) {
      slot.replaceChildren();
      this.renderRecord(slot, value);
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
    if (value.mime === "application/json" && "preview" in value) {
      const preview = element(this.document,"pre", "value-json", string(value.preview));
      preview.dataset.outputMime = "application/json";
      container.appendChild(preview);
      return;
    }
    const kind = string(value.kind);
    if (kind === "widget") {
      container.appendChild(this.createWidget(value, object(value.spec), []));
      const widgetNode = container.firstElementChild;
      if (isElement(widgetNode)) this.patchWidget(widgetNode, value, object(value.spec), []);
      if (this.mode === "static") {
        const notice = element(this.document, "p", "widget-snapshot-note", "Published snapshot (noninteractive).");
        notice.setAttribute("role", "note");
        container.appendChild(notice);
      }
      return;
    }
    if (kind === "text") {
      const pre = element(this.document,"pre", "value-text", string(value.text));
      container.appendChild(pre);
      if (value.truncated === true) container.appendChild(element(this.document,"div", "truncation-note", "Output truncated."));
      return;
    }
    if (kind === "table") {
      this.renderTable(container, value);
      return;
    }
    if (kind === "image") {
      const image = this.document.createElement("img");
      image.className = "plot";
      image.alt = string(value.alt) || "Plot";
      image.setAttribute("alt", image.alt);
      this.loadArtifact(image, value.artifact);
      container.appendChild(image);
      return;
    }
    if (kind === "html") {
      const frame = this.document.createElement("iframe");
      frame.className = "html-widget";
      frame.title = string(value.alt_text) || "HTML widget";
      frame.setAttribute("title", frame.title);
      if (value.artifact !== undefined) {
        this.isolateArtifactFrame(frame, "html");
        this.loadArtifact(frame, value.artifact);
      } else if (value.html !== undefined) {
        // Inline HTML is host-sanitized and explicitly marked inline by the
        // output metadata before it reaches this renderer.
        frame.remove();
        const inline = element(this.document,"div", "html-inline");
        inline.innerHTML = string(value.html);
        container.appendChild(inline);
        return;
      }
      const height = number(value.height);
      if (height !== null) {
        frame.height = String(Math.max(100, height));
        frame.setAttribute("height", frame.height);
      }
      container.appendChild(frame);
      return;
    }
    if (kind === "markdown") {
      const markdown = element(this.document,"div", "markdown-output");
      // OutputStore sanitizes this field before it enters authoritative host
      // state; the renderer never interpolates client-authored HTML here.
      markdown.innerHTML = string(value.html);
      container.appendChild(markdown);
      return;
    }
    if (kind === "media") {
      const mediaKind = string(value.media_type) || "image";
      let media: HTMLMediaElement | HTMLIFrameElement | HTMLImageElement;
      if (mediaKind === "audio") {
        media = this.document.createElement("audio");
        media.controls = true;
        media.setAttribute("controls", "");
      } else if (mediaKind === "video") {
        media = this.document.createElement("video");
        media.controls = true;
        media.setAttribute("controls", "");
      } else if (mediaKind === "pdf") {
        const frame = this.document.createElement("iframe");
        frame.title = string(value.alt) || "PDF";
        frame.setAttribute("title", frame.title);
        frame.className = "media-pdf";
        this.isolateArtifactFrame(frame, "pdf");
        media = frame;
      } else {
        media = this.document.createElement("img");
        media.alt = string(value.alt);
        media.setAttribute("alt", media.alt);
      }
      media.classList.add("out-media");
      this.loadArtifact(media, value.artifact);
      container.appendChild(media);
      return;
    }
    if (kind === "layout") {
      this.renderLayout(container, value);
      return;
    }
    if (kind === "lazy") {
      if (value.child) this.renderRecord(container, value.child);
      else if (this.mode === "static") {
        container.appendChild(element(this.document, "span", "out-lazy", string(value.label) || "Output not materialized"));
      } else {
        const button = element(this.document, "button", "out-lazy", string(value.label) || "Show");
        button.type = "button";
        button.addEventListener("click", () => {
          button.disabled = true;
          void this.interactiveActions().lazy(string(value.key)).catch((error) => {
            button.disabled = false;
            container.appendChild(element(this.document, "div", "output-error", message(error, "Lazy output failed")));
            this.interactiveActions().error(error);
          });
        });
        container.appendChild(button);
      }
      return;
    }
    if (kind === "progress") {
      const row = element(this.document,"div", "progress-row");
      const progress = this.document.createElement("progress");
      const total = number(value.total);
      if (total !== null) {
        progress.max = total;
        progress.setAttribute("max", String(total));
      }
      progress.value = number(value.value) ?? 0;
      progress.setAttribute("value", String(progress.value));
      const labelText = string(value.label) || "Operation in progress";
      progress.setAttribute("aria-label", labelText);
      row.append(progress, element(this.document,"div", "progress-label", labelText));
      container.appendChild(row);
      return;
    }
    if (kind === "error") {
      container.appendChild(element(this.document,"div", "output-error", string(value.message) || "Evaluation failed"));
    }
  }

  private isolateArtifactFrame(frame: HTMLIFrameElement, kind: "html" | "pdf"): void {
    frame.setAttribute("data-alder-artifact-frame", kind);
    // Chromium's native PDF plugin refuses every sandbox policy; sandbox executable HTML only.
    if (kind === "html") frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("referrerpolicy", "no-referrer");
  }

  private loadArtifact(element: HTMLImageElement | HTMLMediaElement | HTMLIFrameElement, descriptor: unknown): void {
    if (!isArtifactDescriptor(descriptor)) return;
    const pending = Promise.resolve()
      .then(() => this.resolveArtifact(descriptor))
      .then((source) => {
        if (source.kind === "url") {
          element.setAttribute("src", source.url);
          element.src = source.url;
          return;
        }
        if (!isTag(element, "iframe")) throw new Error("HTML artifact source requires an iframe");
        const frame = element;
        frame.setAttribute("srcdoc", source.html);
        frame.srcdoc = source.html;
      })
      .catch((error) => {
        if (this.mode === "interactive") this.interactiveActions().error(error);
        else if (this.artifactFailure === null) this.artifactFailure = error;
      });
    this.pendingArtifacts.add(pending);
    void pending.then(() => this.pendingArtifacts.delete(pending));
  }

  private renderLayout(container: HTMLElement, output: JsonObject): void {
    const layout = string(output.layout) || "vstack";
    const wrap = element(this.document,"div", `out-layout out-${safeClass(layout)}`);
    const attrs = object(output.attrs);
    if (layout === "callout") wrap.classList.add(`out-callout-${safeClass(string(attrs.variant) || "info")}`);
    const children = array(output.children);
    const slots = children.map((child, index) => {
      const slot = element(this.document,"div", "out-layout-child");
      slot.dataset.index = String(index);
      this.renderRecord(slot, child);
      wrap.appendChild(slot);
      return slot;
    });
    if (this.mode === "static") {
      if (layout === "tabs" || layout === "accordion") {
        const titles = array(attrs.titles);
        slots.forEach((slot, index) => {
          slot.hidden = false;
          slot.removeAttribute("hidden");
          const title = string(titles[index]);
          if (title) slot.prepend(element(this.document, "div", "out-layout-title", title));
        });
      }
      container.appendChild(wrap);
      return;
    }
    if ((layout === "tabs" || layout === "accordion") && slots.length) {
      const titles = array(attrs.titles);
      const prefix = `alder-output-${layout}-${++this.layoutSequence}`;
      const controls = element(this.document,"div", layout === "tabs" ? "out-tabs" : "out-accordion");
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
        const button = element(this.document,"button", layout === "tabs" ? "out-tab-btn" : "out-accordion-btn",
          string(titles[index]) || `Item ${index + 1}`);
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
    if (this.mode === "static") {
      this.renderStaticTable(container, output);
      return;
    }
    const page = object(output.page);
    const columns = list(page.columns ?? output.columns).map(string);
    const rows = array(page.preview ?? output.preview);
    const offset = number(page.offset) ?? 0;
    const configured = this.interactiveActions().pageSize();
    const limit = Number.isInteger(configured) && configured >= 5 ? configured : number(page.limit) ?? Math.max(1, rows.length || 25);
    const total = number(page.nrow) ?? number(output.nrow) ?? 0;
    const sortBy = string(page.sort_by);
    const sortDescending = page.sort_desc === true;
    const filter = string(page.filter);
    const handle = string(output.handle);
    const request = (update: Partial<Parameters<OutputActions["table"]>[0]>, control: HTMLButtonElement | HTMLInputElement): void => {
      control.disabled = true;
      void this.interactiveActions().table({ handle, offset, limit, sortBy, sortDescending, filter, ...update })
        .catch((error) => { control.disabled = false; this.interactiveActions().error(error); });
    };
    const wrap = element(this.document,"div", "table-preview");
    const table = this.document.createElement("table");
    const head = this.document.createElement("thead");
    const headRow = this.document.createElement("tr");
    columns.forEach((column) => {
      const th = this.document.createElement("th");
      const sort = element(this.document,"button", "table-sort", `${column}${sortBy === column ? sortDescending ? " (desc)" : " (asc)" : ""}`);
      sort.type = "button";
      sort.dataset.role = "table-sort";
      sort.dataset.column = column;
      sort.addEventListener("click", () => request({ sortBy: column, sortDescending: sortBy === column ? !sortDescending : false }, sort));
      th.appendChild(sort);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = this.document.createElement("tbody");
    rows.forEach((raw) => {
      const row = this.document.createElement("tr");
      const values = Array.isArray(raw) ? raw : isObject(raw) ? columns.map((column) => raw[column]) : [];
      columns.forEach((_column, index) => row.appendChild(element(this.document,"td", "", string(values[index]))));
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    container.appendChild(wrap);

    const toolbar = element(this.document,"div", "table-toolbar");
    const input = this.document.createElement("input");
    input.type = "search";
    input.className = "table-filter";
    input.dataset.role = "table-filter";
    input.placeholder = "Filter text columns";
    input.setAttribute("aria-label", "Filter table");
    input.value = filter;
    let timer: number | null = null;
    const view = this.document.defaultView;
    input.addEventListener("input", () => {
      if (timer !== null) view?.clearTimeout(timer);
      timer = view?.setTimeout(() => request({ offset: 0, filter: input.value }, input), 250) ?? null;
    });
    toolbar.appendChild(input);
    const copy = element(this.document,"button", "table-copy", "Copy TSV");
    copy.type = "button";
    copy.dataset.role = "table-copy";
    copy.addEventListener("click", () => void copyTsv(this.document,columns, rows).then(() => {
      copy.textContent = "Copied";
      view?.setTimeout(() => { copy.textContent = "Copy TSV"; }, 1_000);
    }).catch((error) => this.interactiveActions().error(error)));
    toolbar.appendChild(copy);
    container.appendChild(toolbar);

    const pager = element(this.document,"div", "table-pager");
    const previous = element(this.document,"button", "", "Prev");
    previous.type = "button";
    previous.disabled = offset <= 0;
    previous.addEventListener("click", () => request({ offset: Math.max(0, offset - limit) }, previous));
    const next = element(this.document,"button", "", "Next");
    next.type = "button";
    next.disabled = offset + rows.length >= total;
    next.addEventListener("click", () => request({ offset: offset + limit }, next));
    pager.append(previous, element(this.document,"div", "table-page-label", `${total === 0 ? 0 : offset + 1}..${Math.min(total, offset + rows.length)} of ${total}`), next);
    container.appendChild(pager);
    container.appendChild(element(this.document,"div", "table-meta", `${number(output.nrow) ?? total} rows × ${number(output.ncol) ?? columns.length} columns`));
    const truncated = [output.truncated_rows ? "rows truncated" : "", output.truncated_columns ? "columns truncated" : ""].filter(Boolean);
    if (truncated.length) container.appendChild(element(this.document,"div", "truncation-note", truncated.join("; ")));
  }

  private renderStaticTable(container: HTMLElement, output: JsonObject): void {
    const page = object(output.page);
    const columns = list(page.columns ?? output.columns).map(string);
    const rows = array(page.preview ?? output.preview);
    const wrap = element(this.document, "div", "table-preview");
    const table = this.document.createElement("table");
    const head = this.document.createElement("thead");
    const headRow = this.document.createElement("tr");
    columns.forEach((column) => headRow.appendChild(element(this.document, "th", "", column)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = this.document.createElement("tbody");
    rows.forEach((raw) => {
      const row = this.document.createElement("tr");
      const values = Array.isArray(raw) ? raw : isObject(raw) ? columns.map((column) => raw[column]) : [];
      columns.forEach((_column, index) => row.appendChild(element(this.document, "td", "", string(values[index]))));
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    container.appendChild(wrap);
    const total = number(page.nrow) ?? number(output.nrow) ?? 0;
    container.appendChild(element(this.document, "div", "table-meta", `${number(output.nrow) ?? total} rows × ${number(output.ncol) ?? columns.length} columns`));
    const truncated = [output.truncated_rows ? "rows truncated" : "", output.truncated_columns ? "columns truncated" : ""].filter(Boolean);
    if (truncated.length) container.appendChild(element(this.document, "div", "truncation-note", truncated.join("; ")));
  }
  private createWidget(widget: JsonObject, spec: JsonObject, path: readonly string[]): HTMLElement {
    const kind = string(spec.kind);
    const node = element(this.document,"div", ["array", "dictionary", "form"].includes(kind) ? "widget-group" : "widget-container");
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
      const submit = this.control(this.document.createElement("button"), widget, spec, kind, path);
      submit.type = "button";
      submit.setAttribute("type", "button");
      submit.textContent = string(spec.submit_label) || "Submit";
      submit.dataset.formSubmit = "true";
      if (this.mode === "interactive") submit.addEventListener("click", () => this.submitForm(node, widget, spec, path, submit));
      node.appendChild(submit);
      return node;
    }
    if (kind === "table" || kind === "dataframe") {
      this.appendLabel(node, spec, null);
      this.buildWidgetTable(node, widget, spec, kind, path);
      return node;
    }
    if (kind === "radio") {
      const fieldset = this.document.createElement("fieldset");
      this.appendLabel(fieldset, spec, null, "legend");
      array(spec.choices).forEach((choice, index) => {
        const label = this.document.createElement("label");
        const input = this.control(this.document.createElement("input"), widget, spec, kind, path);
        input.type = "radio";
        input.setAttribute("type", "radio");
        input.name = `${string(widget.name)}-${path.join("-")}`;
        input.setAttribute("name", input.name);
        input.value = String(index + 1);
        input.setAttribute("value", input.value);
        if (this.mode === "interactive") input.addEventListener("change", () => this.sendWidget(widget, path, { index: index + 1 }, input));
        label.append(input, this.document.createTextNode(string(choice)));
        fieldset.appendChild(label);
      });
      node.appendChild(fieldset);
      return node;
    }
    let control: HTMLElement;
    if (kind === "dropdown" || kind === "multiselect") {
      const select = this.document.createElement("select");
      select.multiple = kind === "multiselect";
      if (select.multiple) select.setAttribute("multiple", "");
      array(spec.choices).forEach((choice, index) => {
        const option = this.document.createElement("option");
        option.value = String(index + 1);
        option.setAttribute("value", option.value);
        option.textContent = string(choice);
        select.appendChild(option);
      });
      control = this.control(select, widget, spec, kind, path);
    } else if (["run_button", "button", "refresh"].includes(kind)) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.setAttribute("type", "button");
      button.textContent = string(spec.label) || (kind === "run_button" ? "Run" : kind);
      control = this.control(button, widget, spec, kind, path);
    } else if (kind === "text_area" || kind === "code_editor") {
      const area = this.document.createElement("textarea");
      const rows = number(spec.rows);
      if (rows !== null) {
        area.rows = rows;
        area.setAttribute("rows", String(rows));
      }
      control = this.control(area, widget, spec, kind, path);
    } else if (kind === "range_slider" || kind === "date_range") {
      control = this.document.createElement("div");
      [0, 1].forEach((part) => {
        const input = this.control(this.document.createElement("input"), widget, spec, kind, path);
        input.type = kind === "range_slider" ? "range" : "date";
        input.setAttribute("type", input.type);
        input.dataset.rangePart = String(part);
        control.appendChild(input);
      });
    } else {
      const input = this.document.createElement("input");
      input.type = kind === "file" ? "file" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" :
        kind === "checkbox" || kind === "switch" ? "checkbox" : kind === "slider" ? "range" : kind === "number" ? "number" : "text";
      input.setAttribute("type", input.type);
      if (kind === "file") {
        input.multiple = spec.multiple === true;
        if (input.multiple) input.setAttribute("multiple", "");
        if (spec.accept) {
          input.accept = Array.isArray(spec.accept) ? spec.accept.map(string).join(",") : string(spec.accept);
          input.setAttribute("accept", input.accept);
        }
      }
      control = this.control(input, widget, spec, kind, path);
    }
    const labelled = isTag(control, "input") || isTag(control, "select") || isTag(control, "textarea") || isTag(control, "button") ? control : null;
    this.appendLabel(node, spec, labelled);
    node.appendChild(control);
    if (kind === "datetime") {
      const timezone = element(this.document,"span", "widget-timezone", "UTC");
      timezone.id = `${labelled?.id ?? "widget"}-timezone`;
      labelled?.setAttribute("aria-describedby", timezone.id);
      labelled?.setAttribute("title", "UTC date and time");
      node.appendChild(timezone);
    }
    if (kind === "slider" || kind === "number") node.appendChild(element(this.document,"span", "widget-value"));
    this.bindWidgetControls(node, widget, kind, path);
    return node;
  }

  private bindWidgetControls(node: HTMLElement, widget: JsonObject, kind: string, path: readonly string[]): void {
    if (this.mode === "static") return;
    const controls = this.widgetControls(node, kind, path);
    const send = (update: JsonObject, control: WidgetControl): void => {
      void this.sendWidget(widget, path, update, control);
    };
    for (const control of controls) {
      if (!isWidgetControl(control)) continue;
      if (kind === "run_button") control.addEventListener("click", () => send({ value: true }, control));
      else if (kind === "button" || kind === "refresh") control.addEventListener("click", () => {
        const current = Number(control.dataset.value ?? 0);
        send({ value: Number.isFinite(current) ? Math.floor(current) + 1 : 1, ...(kind === "refresh" ? { paused: false } : {}) }, control);
      });
      else if (kind === "file" && isTag(control, "input")) control.addEventListener("change", () => {
        control.disabled = true;
        let upload!: Promise<void>;
        upload = this.interactiveActions().upload(string(widget.name), path, Array.from(control.files ?? []))
          .then(() => undefined, (error) => {
            this.lastFailure = { error };
            this.interactiveActions().error(error);
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
          else if (kind === "multiselect" && isTag(control, "select")) send({ indices: Array.from(control.selectedOptions).map((option) => Number(option.value)) }, control);
          else if ((kind === "checkbox" || kind === "switch") && isTag(control, "input")) send({ value: control.checked }, control);
          else if (kind === "slider" || kind === "number") {
            const value = Number(control.value);
            const label = node.querySelector(".widget-value");
            if (label) label.textContent = String(value);
            if (Number.isFinite(value)) send({ value }, control);
          } else if (kind === "range_slider") send({ value: controls.map((item) => Number(item.value)) }, control);
          else if (kind === "date_range") send({ value: controls.map((item) => item.value) }, control);
          else if (kind === "datetime") send({ value: datetimeWire(control.value) }, control);
          else send({ value: control.value }, control);
        });
      }
    }
  }

  private sendWidget(widget: JsonObject, path: readonly string[], update: JsonObject, control: WidgetControl): Promise<void> {
    const origin = this.controlOrigins.get(control);
    if (origin === undefined) {
      this.interactiveActions().error(new Error("widget output is no longer current"));
      return Promise.resolve();
    }
    const key = widgetKey(widget, string(control.dataset.kind), path);
    const oneShot = ["run_button", "button", "refresh", "form"].includes(string(control.dataset.kind));
    const current = this.pendingWidgets.get(key);
    if (current) {
      // Continuous native controls stay responsive. Preserve only the newest
      // value while the exact prior widget operation and causal reset settle.
      if (!current.oneShot) current.update = update;
      return current.done;
    }
    const predecessors = Array.from(this.pendingWidgets.values()).filter((operation) => string(operation.widget.name) === string(widget.name));
    if (oneShot) control.setAttribute("disabled", "");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const pending: PendingWidget = {
      widget, origin, path: [...path], update, authoritative: null, oneShot, control, failure: null, done, resolveDone,
    };
    this.pendingWidgets.set(key, pending);
    void (async () => {
      try {
        for (const predecessor of predecessors) {
          await predecessor.done;
          if (predecessor.failure !== null) throw predecessor.failure;
          if (pending.origin.owner === predecessor.origin.owner
            && pending.origin.revision === predecessor.origin.revision
            && pending.origin.outputId === predecessor.origin.outputId
            && pending.origin.kernelEpoch === predecessor.origin.kernelEpoch) {
            pending.origin = predecessor.origin;
          }
        }
        while (pending.update) {
          const next = pending.update;
          pending.update = null;
          const result = await this.interactiveActions().widget(string(pending.widget.name), pending.path, next, pending.origin);
          if (isObject(result) && isObject(result.result) && typeof result.result.outputRecordId === "string" && typeof result.result.outputGeneration === "number") {
            pending.origin = { ...pending.origin, outputId: result.result.outputRecordId, outputGeneration: result.result.outputGeneration };
            const slot = pending.control.closest(".out-record");
            for (const candidate of Array.from(slot?.querySelectorAll<HTMLElement>("[data-role=widget]") ?? [])) {
              if (!isWidgetControl(candidate) || candidate.dataset.name !== string(pending.widget.name)) continue;
              const currentOrigin = this.controlOrigins.get(candidate);
              if (currentOrigin?.owner === pending.origin.owner
                && currentOrigin.revision === pending.origin.revision
                && currentOrigin.outputId === pending.origin.outputId
                && currentOrigin.kernelEpoch === pending.origin.kernelEpoch
                && currentOrigin.outputGeneration <= pending.origin.outputGeneration) {
                this.controlOrigins.set(candidate, pending.origin);
              }
            }
          }
        }
      } catch (error) {
        pending.failure = error;
        this.lastFailure = { error };
        this.interactiveActions().error(error);
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
    const table = this.document.createElement("table");
    table.className = "widget-table";
    const head = this.document.createElement("thead");
    const row = this.document.createElement("tr");
    if (kind === "table") row.appendChild(this.document.createElement("th"));
    columns.forEach((column) => row.appendChild(element(this.document,"th", "", column)));
    head.appendChild(row);
    table.appendChild(head);
    const body = this.document.createElement("tbody");
    array(page.preview).forEach((raw, index) => {
      const tr = this.document.createElement("tr");
      if (kind === "table") {
        const td = this.document.createElement("td");
        const input = this.control(this.document.createElement("input"), widget, spec, kind, path);
        if (!isTag(input, "input")) return;
        input.type = "checkbox";
        input.setAttribute("type", "checkbox");
        input.value = String(index + 1);
        input.setAttribute("value", String(index + 1));
        const checked = selected.has(index + 1);
        if (this.mode === "static") input.toggleAttribute("checked", checked);
        else input.checked = checked;
        if (this.mode === "interactive") input.addEventListener("change", () => {
          const values = this.widgetControls(node, kind, path)
            .filter((entry): entry is HTMLInputElement => isTag(entry, "input") && entry.checked)
            .map((entry) => Number(entry.value));
          this.sendWidget(widget, path, { selected: values }, input);
        });
        td.appendChild(input);
        tr.appendChild(td);
      }
      array(raw).forEach((value) => tr.appendChild(element(this.document,"td", "", string(value))));
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
    const origin = this.widgetOrigins.get(widget);
    if (origin !== undefined) {
      for (const control of Array.from(node.querySelectorAll<HTMLElement>("[data-role=widget]"))) {
        if (!isWidgetControl(control)) continue;
        const previous = this.controlOrigins.get(control);
        if (previous?.owner === origin.owner && previous.revision === origin.revision
          && previous.outputId === origin.outputId && previous.kernelEpoch === origin.kernelEpoch
          && previous.outputGeneration > origin.outputGeneration) continue;
        this.controlOrigins.set(control, origin);
      }
    }
    const key = widgetKey(widget, kind, path);
    const operation = this.pendingWidgets.get(key);
    const pending = operation !== undefined;
    if (operation) operation.authoritative = { node, widget, spec, path: [...path] };
    const current = this.mode === "static" ? false : this.interactiveActions().widgetAvailable(widget);
    node.dataset.current = String(current);
    node.dataset.pending = String(pending);
    node.toggleAttribute("aria-busy", pending);
    if (kind === "array" || kind === "dictionary") {
      for (const child of array(spec.children).filter(isObject)) {
        const childPath = [...path, string(child.name)];
        const found = Array.from(node.children).find((item) => isElement(item) && item.dataset?.widgetKey === widgetKey(widget, string(child.kind), childPath));
        if (isElement(found)) this.patchWidget(found, widget, child, childPath, force);
      }
      return;
    }
    if (kind === "form") {
      const child = object(spec.child);
      const found = Array.from(node.children).find((item) => isElement(item) && item.dataset?.widgetKey === widgetKey(widget, string(child.kind), path));
      if (isElement(found)) this.patchWidget(found, widget, child, path, force);
      const submit = node.querySelector<HTMLButtonElement>("[data-form-submit=true]");
      const submitting = this.pendingForms.has(key);
      if (submit) {
        submit.disabled = !current || pending || submitting || spec.dirty !== true;
        submit.toggleAttribute("disabled", submit.disabled);
      }
      if (submitting && isElement(found)) {
        for (const child of Array.from(found.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("[data-role=widget]"))) {
          child.disabled = true;
        }
      }
      return;
    }
    if ((kind === "table" || kind === "dataframe") && (force || this.mode === "static" || !node.contains(this.document.activeElement) && !pending)) {
      const replacement = this.createWidget(widget, spec, path);
      node.replaceChildren(...Array.from(replacement.childNodes));
      return;
    }
    const controls = this.widgetControls(node, kind, path);
    const oneShot = ["run_button", "button", "refresh", "file"].includes(kind);
    controls.forEach((control) => {
      const disabled = !current || pending && oneShot;
      control.disabled = disabled;
      control.toggleAttribute("disabled", disabled);
      if (spec.value !== undefined && !Array.isArray(spec.value)) control.dataset.value = string(spec.value);
    });
    if (!force && this.mode !== "static" && (node.contains(this.document.activeElement) || pending)) return;
    const control = controls[0];
    if (!control) return;
    if (kind === "dropdown" && isTag(control, "select")) {
      const selected = String(Number.isInteger(spec.index) ? spec.index : 1);
      if (this.mode === "static") Array.from(control.options).forEach((option) => option.toggleAttribute("selected", option.value === selected));
      else control.value = selected;
    }
    else if (kind === "multiselect" && isTag(control, "select")) {
      const selected = new Set(array(spec.indices).map(Number));
      Array.from(control.options).forEach((option) => {
        const isSelected = selected.has(Number(option.value));
        if (this.mode === "static") option.toggleAttribute("selected", isSelected);
        else option.selected = isSelected;
      });
    } else if (kind === "radio") {
      const selected = Number.isInteger(spec.index) ? Number(spec.index) : 1;
      controls.forEach((item) => {
        if (!isTag(item, "input")) return;
        const isSelected = Number(item.value) === selected;
        if (this.mode === "static") item.toggleAttribute("checked", isSelected);
        else item.checked = isSelected;
      });
    } else if ((kind === "checkbox" || kind === "switch") && isTag(control, "input")) {
      const checked = spec.value === true;
      if (this.mode === "static") control.toggleAttribute("checked", checked);
      else control.checked = checked;
    }
    else if (kind === "range_slider" || kind === "date_range") {
      const values = array(spec.value);
      controls.forEach((item, index) => {
        if (isTag(item, "input")) this.patchBounded(item, spec, values[index], kind === "date_range");
      });
    } else if (kind === "datetime") {
      if (isTag(control, "input")) {
        this.patchBounded(control, spec, spec.value, true, datetimeLocal);
        if (this.mode === "static") control.setAttribute("step", "1");
        else control.step = "1";
      }
    }
    else if (kind === "date" && isTag(control, "input")) this.patchBounded(control, spec, spec.value, true);
    else if (kind === "file") { /* native file values cannot be restored */ }
    else if ((kind === "slider" || kind === "number") && isTag(control, "input")) this.patchBounded(control, spec, array(spec.value).length ? array(spec.value)[0] : spec.value);
    else if (spec.value !== undefined) {
      const value = string(array(spec.value).length ? array(spec.value)[0] : spec.value);
      if (this.mode === "static") {
        if (isTag(control, "textarea")) control.textContent = value;
        else control.setAttribute("value", value);
      } else control.value = value;
    }
    if (kind === "slider" || kind === "number") {
      const label = node.querySelector(".widget-value");
      if (label) label.textContent = control.value;
    }
    if (this.mode === "static") this.reflectStaticControls(controls);
  }

  private reflectStaticControls(controls: readonly WidgetControl[]): void {
    for (const control of controls) {
      control.setAttribute("disabled", "");
      if (isTag(control, "input")) {
        const input = control;
        control.setAttribute("type", input.type);
        if (input.name) control.setAttribute("name", input.name);
        if (input.multiple) control.setAttribute("multiple", "");
        if (input.accept) control.setAttribute("accept", input.accept);
      } else if (isTag(control, "select")) {
        const select = control;
        if (select.multiple) control.setAttribute("multiple", "");
        for (const option of Array.from(select.options)) option.setAttribute("value", option.value);
      } else if (isTag(control, "textarea")) {
        const area = control;
        if (area.rows) control.setAttribute("rows", String(area.rows));
      }
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
      else {
        const converted = convert(spec[field]);
        if (this.mode === "static") control.setAttribute(field, converted);
        else control[field] = converted;
      }
    }
    if (!noStep && spec.step != null) {
      const step = string(spec.step);
      if (this.mode === "static") control.setAttribute("step", step);
      else control.step = step;
    } else if (!noStep) control.removeAttribute("step");
    const converted = convert(value);
    if (this.mode === "static") control.setAttribute("value", converted);
    else control.value = converted;
  }

  private widgetControls(node: HTMLElement, kind: string, path: readonly string[]): WidgetControl[] {
    const encoded = JSON.stringify(path);
    return Array.from(node.querySelectorAll<HTMLElement>("[data-role=widget]")).filter((item): item is WidgetControl =>
      isWidgetControl(item) && item.dataset.kind === kind && item.dataset.path === encoded,
    );
  }

  private control<T extends HTMLElement>(control: T, widget: JsonObject, _spec: JsonObject, kind: string, path: readonly string[]): T {
    control.dataset.role = "widget";
    control.dataset.name = string(widget.name);
    control.dataset.kind = kind;
    control.dataset.owner = string(widget.owner);
    control.dataset.path = JSON.stringify(path);
    control.id = `widget-${safePart(widget.owner)}-${safePart(kind)}${path.length ? `-${safePart(path.join("-"))}` : ""}`;
    const origin = this.widgetOrigins.get(widget);
    if (origin && isWidgetControl(control)) this.controlOrigins.set(control, origin);
    if (this.mode === "static") control.setAttribute("disabled", "");
    return control;
  }

  private appendLabel(parent: HTMLElement, spec: JsonObject, control: HTMLElement | null, tag: "label" | "legend" = "label"): void {
    const labelText = string(spec.label);
    if (!labelText) return;
    const label = this.document.createElement(tag);
    label.dataset.role = "widget-label";
    label.textContent = labelText;
    if (tag === "label" && control && isTag(label, "label")) label.htmlFor = control.id;
    parent.appendChild(label);
  }
}



function outputData(record: OutputRecord): unknown {
  const data: unknown = record.data;
  if (!isObject(data)) return data;
  if (data.kind === "html" && data.html !== undefined && record.metadata.presentation !== "inline") {
    return { kind: "html", artifact: data.artifact, alt_text: data.alt_text };
  }
  return data;
}

function isArtifactDescriptor(value: unknown): value is ArtifactHandle {
  return isObject(value) && typeof value.handle === "string" && typeof value.mimeType === "string" && Number.isSafeInteger(value.byteLength) && value.chunkBytes === OUTPUT_CHUNK_BYTES && typeof value.epoch === "string" && typeof value.documentRevision === "number" && (value.kernelEpoch === null || typeof value.kernelEpoch === "string");
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

async function copyTsv(document: Document, columns: readonly string[], rows: readonly unknown[]): Promise<void> {
  const text = [columns.join("\t"), ...rows.map((raw) => {
    const values = Array.isArray(raw) ? raw : isObject(raw) ? columns.map((column) => raw[column]) : [];
    return values.map(string).join("\t");
  })].join("\n");
  const view = document.defaultView;
  if (view?.navigator.clipboard?.writeText) return view.navigator.clipboard.writeText(text);
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

function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isElement(value: unknown): value is HTMLElement {
  return typeof value === "object" && value !== null && (value as { nodeType?: unknown }).nodeType === 1;
}

function isTag<K extends keyof HTMLElementTagNameMap>(value: unknown, tag: K): value is HTMLElementTagNameMap[K] {
  return isElement(value) && string((value as { tagName?: unknown }).tagName).toLowerCase() === tag;
}

function isWidgetControl(value: unknown): value is WidgetControl {
  return isTag(value, "input") || isTag(value, "select") || isTag(value, "textarea") || isTag(value, "button");
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
