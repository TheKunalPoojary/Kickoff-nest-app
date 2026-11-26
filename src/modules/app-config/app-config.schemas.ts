import { z } from 'zod';

const SemverSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, 'Use a MAJOR.MINOR.PATCH version, e.g. 1.4.0');

const PlatformVersionSchema = z
  .object({
    /** Below this the app is blocked by an "update required" screen (if forceUpdate is on). */
    min: SemverSchema,
    /** Below this the app shows a dismissible "update available" popup (if promptEnabled is on). */
    latest: SemverSchema,
    storeUrl: z.string().url().or(z.literal('')),
    /**
     * Master switch for the blocking screen. Off: versions below `min` are only
     * nagged, not locked out. Defaults ON so rows saved before this field existed
     * keep enforcing `min`.
     */
    forceUpdate: z.boolean().default(true),
    /** Master switch for the dismissible popup. Off: nothing is shown below `latest`. */
    promptEnabled: z.boolean().default(true),
    /** Optional text shown in the popup / blocking screen; empty uses the app's default copy. */
    message: z.string().trim().max(300).default(''),
  })
  .refine((v) => compareVersions(v.min, v.latest) <= 0, {
    message: 'min must not be newer than latest',
    path: ['min'],
  });

export const AppVersionsSchema = z.object({
  ios: PlatformVersionSchema,
  android: PlatformVersionSchema,
});

export const MaintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(300),
});

/** Flag names are free-form so a new flag ships without a backend release. */
export const FeatureFlagsSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
  z.boolean(),
);

/** Each AppSetting row's key and the schema its JSON value must satisfy. */
export const APP_SETTING_SCHEMAS = {
  'app.versions': AppVersionsSchema,
  'app.maintenance': MaintenanceSchema,
  'app.features': FeatureFlagsSchema,
} as const;

export type AppSettingKey = keyof typeof APP_SETTING_SCHEMAS;

export const AppConfigSchema = z.object({
  versions: AppVersionsSchema,
  maintenance: MaintenanceSchema,
  features: FeatureFlagsSchema,
});

export const UpdateAppConfigSchema = AppConfigSchema.partial();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UpdateAppConfigDto = z.infer<typeof UpdateAppConfigSchema>;

export const DEFAULT_APP_SETTINGS: { [K in AppSettingKey]: z.input<(typeof APP_SETTING_SCHEMAS)[K]> } = {
  'app.versions': {
    ios: { min: '1.0.0', latest: '1.0.0', storeUrl: '', forceUpdate: true, promptEnabled: true, message: '' },
    android: { min: '1.0.0', latest: '1.0.0', storeUrl: '', forceUpdate: true, promptEnabled: true, message: '' },
  },
  'app.maintenance': { enabled: false, message: '' },
  'app.features': { arcade: true, squads: false, reviews: false },
};

/** Numeric MAJOR.MINOR.PATCH comparison — '1.10.0' is newer than '1.9.0'. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
