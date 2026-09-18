import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Alder',
    executableName: process.platform === 'linux' ? 'alder-desktop' : 'Alder',
    appBundleId: 'dev.alder.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Alder R notebook',
          CFBundleTypeRole: 'Editor',
          CFBundleTypeExtensions: ['R', 'r', 'Rmd', 'rmd'],
          LSHandlerRank: 'Alternate',
        },
      ],
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      config: {},
      platforms: ['linux', 'darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          bin: 'alder-desktop',
          maintainer: 'Alder contributors',
          homepage: 'https://github.com/alder-dev/alder',
        },
      },
      platforms: ['linux'],
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          bin: 'alder-desktop',
          license: 'Apache-2.0',
          homepage: 'https://github.com/alder-dev/alder',
        },
      },
      platforms: ['linux'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: { format: 'ULFO' },
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'alder' },
      platforms: ['win32'],
    },
  ],
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
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
