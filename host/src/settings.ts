import { z } from "zod";

const editorSchema = z.object({
  font_size: z.number().int().min(10).max(32),
  tab_size: z.number().int().min(1).max(8),
  line_numbers: z.boolean(),
  completions: z.boolean(),
  signature_help: z.boolean(),
  live_diagnostics: z.boolean(),
}).strict();
const formatSchema = z.object({ on_save: z.boolean() }).strict();
const tableSchema = z.object({ page_size: z.number().int().min(5).max(200) }).strict();

const editablePreferencesSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  keymap: z.enum(["default", "vim"]),
  autosave: z.boolean(),
  format: formatSchema,
  editor: editorSchema,
  table: tableSchema,
}).strict();
export const preferencesSchema = editablePreferencesSchema.extend({
  rscript: z.string().min(1).nullable(),
});
export const preferencesPatchSchema = editablePreferencesSchema.extend({
  format: formatSchema.partial(),
  editor: editorSchema.partial(),
  table: tableSchema.partial(),
}).partial();
export const storedPreferencesPatchSchema = preferencesPatchSchema.extend({
  rscript: z.string().min(1).nullable().optional(),
});

const notebookCacheSchema = z.object({ enabled: z.boolean() }).strict();
export const notebookSettingsSchema = z.object({
  on_cell_change: z.enum(["automatic", "lazy"]),
  on_startup: z.boolean(),
  cache: notebookCacheSchema,
}).strict();
export const notebookSettingsPatchSchema = notebookSettingsSchema.extend({
  cache: notebookCacheSchema.partial(),
}).partial();

const projectCacheSchema = z.object({ dir: z.string().min(1).nullable() }).strict();
export const projectSettingsSchema = z.object({ cache: projectCacheSchema }).strict();
export const projectSettingsPatchSchema = projectSettingsSchema.extend({
  cache: projectCacheSchema.partial(),
}).partial();

export const configSchema = preferencesSchema.extend({
  on_cell_change: notebookSettingsSchema.shape.on_cell_change,
  on_startup: notebookSettingsSchema.shape.on_startup,
  cache: notebookCacheSchema.extend(projectCacheSchema.shape),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;
export type StoredPreferencesPatch = z.infer<typeof storedPreferencesPatchSchema>;
export type NotebookSettingsPatch = z.infer<typeof notebookSettingsPatchSchema>;
export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;
export type Config = z.infer<typeof configSchema>;

export function preferenceDefaults(): Preferences {
  return {
    rscript: null,
    theme: "system",
    keymap: "default",
    autosave: false,
    format: { on_save: false },
    editor: {
      font_size: 14,
      tab_size: 2,
      line_numbers: true,
      completions: true,
      signature_help: true,
      live_diagnostics: false,
    },
    table: { page_size: 25 },
  };
}

export function mergePreferences(current: Preferences, patch: StoredPreferencesPatch): Preferences {
  return {
    rscript: patch.rscript === undefined ? current.rscript : patch.rscript,
    theme: patch.theme ?? current.theme,
    keymap: patch.keymap ?? current.keymap,
    autosave: patch.autosave ?? current.autosave,
    format: { ...current.format, ...patch.format },
    editor: { ...current.editor, ...patch.editor },
    table: { ...current.table, ...patch.table },
  };
}

export function configDefaults(): Config {
  return {
    ...preferenceDefaults(),
    on_cell_change: "automatic",
    on_startup: true,
    cache: { enabled: true, dir: null },
  };
}

/** Each owner supplies only its own fields; defaults fill omitted values. */
export function resolveSettings(options: {
  preferences?: StoredPreferencesPatch;
  notebook?: NotebookSettingsPatch;
  project?: ProjectSettingsPatch;
} = {}): Config {
  const defaults = configDefaults();
  return {
    ...mergePreferences(defaults, options.preferences ?? {}),
    on_cell_change: options.notebook?.on_cell_change ?? defaults.on_cell_change,
    on_startup: options.notebook?.on_startup ?? defaults.on_startup,
    cache: {
      enabled: options.notebook?.cache?.enabled ?? defaults.cache.enabled,
      dir: options.project?.cache?.dir ?? defaults.cache.dir,
    },
  };
}
