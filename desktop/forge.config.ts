import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Alder',
    executableName: 'Alder',
    appBundleId: 'dev.alder.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Alder R notebook',
          CFBundleTypeRole: 'Editor',
          CFBundleTypeExtensions: ['R', 'r'],
          LSHandlerRank: 'Alternate',
        },
      ],
    },
  },
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/entry.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Window cookies stay in memory, so launching does not need a Keychain key.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
