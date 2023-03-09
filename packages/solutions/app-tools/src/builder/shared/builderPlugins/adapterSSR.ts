import {
  BuilderPlugin,
  BundlerChain,
  mergeBuilderConfig,
} from '@modern-js/builder-shared';
import { ChainIdentifier, fs } from '@modern-js/utils';
import type {
  AppNormalizedConfig,
  Bundler,
  ServerUserConfig,
  SSGMultiEntryOptions,
} from '../../../types';
import { HtmlAsyncChunkPlugin, RouterPlugin } from '../bundlerPlugins';
import type { BuilderOptions, BuilderPluginAPI } from '../types';
import { getServerCombinedModueFile } from '../../../analyze/utils';
import { isHtmlEnabled } from './adapterHtml';

export const builderPluginAdapterSSR = <B extends Bundler>(
  options: BuilderOptions<B>,
): BuilderPlugin<BuilderPluginAPI> => ({
  name: 'builder-plugin-adapter-modern-ssr',

  setup(api) {
    const { normalizedConfig } = options;
    api.modifyBuilderConfig(config => {
      if (isStreamingSSR(normalizedConfig)) {
        return mergeBuilderConfig(config, {
          html: {
            inject: 'body',
          },
        });
      }
      return config;
    });

    api.modifyBundlerChain(
      async (
        chain,
        { target, CHAIN_ID, isProd, HtmlPlugin: HtmlBundlerPlugin, isServer },
      ) => {
        const builderConfig = api.getNormalizedConfig();

        applyRouterPlugin(chain, options);
        await applySSRLoaderEntry(chain, options, isServer);

        if (['node', 'service-worker'].includes(target)) {
          applyFilterEntriesBySSRConfig({
            isProd,
            chain,
            appNormalizedConfig: options.normalizedConfig,
          });
        }

        if (isHtmlEnabled(builderConfig, target)) {
          applyAsyncChunkHtmlPlugin({
            chain,
            modernConfig: options.normalizedConfig,
            CHAIN_ID,
            HtmlBundlerPlugin,
          });
        }
      },
    );
  },
});

const isStreamingSSR = (userConfig: AppNormalizedConfig<'shared'>): boolean => {
  const isStreaming = (ssr: ServerUserConfig['ssr']) =>
    ssr && typeof ssr === 'object' && ssr.mode === 'stream';

  const { server } = userConfig;

  if (isStreaming(server.ssr)) {
    return true;
  }

  // Since we cannot apply different plugins for different entries,
  // we regard the whole app as streaming ssr only if one entry meets the requirement.
  if (server?.ssrByEntries && typeof server.ssrByEntries === 'object') {
    for (const name of Object.keys(server.ssrByEntries)) {
      if (isStreaming(server.ssrByEntries[name])) {
        return true;
      }
    }
  }

  return false;
};

function applyAsyncChunkHtmlPlugin({
  chain,
  modernConfig,
  CHAIN_ID,
  HtmlBundlerPlugin,
}: {
  chain: BundlerChain;
  modernConfig: AppNormalizedConfig<'shared'>;
  CHAIN_ID: ChainIdentifier;
  HtmlBundlerPlugin: any;
}) {
  if (isStreamingSSR(modernConfig)) {
    chain
      .plugin(CHAIN_ID.PLUGIN.HTML_ASYNC_CHUNK)
      .use(HtmlAsyncChunkPlugin, [HtmlBundlerPlugin]);
  }
}

function applyRouterPlugin<B extends Bundler>(
  chain: BundlerChain,
  options: Readonly<BuilderOptions<B>>,
) {
  const { appContext, normalizedConfig } = options;
  const { entrypoints } = appContext;
  const existNestedRoutes = entrypoints.some(
    entrypoint => entrypoint.nestedRoutesEntry,
  );

  const routerConfig: any = normalizedConfig?.runtime?.router;
  const routerManifest = Boolean(routerConfig?.manifest);

  // for ssr mode
  if (existNestedRoutes || routerManifest) {
    chain.plugin('route-plugin').use(RouterPlugin);
  }
}

function applyFilterEntriesBySSRConfig({
  isProd,
  chain,
  appNormalizedConfig,
}: {
  isProd: boolean;
  chain: BundlerChain;
  appNormalizedConfig: AppNormalizedConfig<'shared'>;
}) {
  const { server: serverConfig, output: outputConfig } = appNormalizedConfig;

  const entries = chain.entryPoints.entries();
  // if prod and ssg config is true or function
  if (
    isProd &&
    (outputConfig?.ssg === true ||
      typeof (outputConfig?.ssg as Array<unknown>)?.[0] === 'function')
  ) {
    return;
  }

  if (typeof entries === 'undefined') {
    throw new Error(
      'No entry found, one of src/routes/layout.tsx, src/App.tsx, src/index.tsx is required',
    );
  }

  // if single entry has ssg config
  // `ssg: {}` is not allowed if multi entry
  const entryNames = Object.keys(entries);
  if (isProd && entryNames.length === 1 && outputConfig?.ssg) {
    return;
  }

  // collect all ssg entries
  const ssgEntries: string[] = [];
  if (isProd && outputConfig?.ssg) {
    const { ssg } = outputConfig;
    entryNames.forEach(name => {
      if ((ssg as SSGMultiEntryOptions)[name]) {
        ssgEntries.push(name);
      }
    });
  }

  const { ssr, ssrByEntries } = serverConfig || {};
  entryNames.forEach(name => {
    if (
      !ssgEntries.includes(name) &&
      ((ssr && ssrByEntries?.[name] === false) ||
        (!ssr && !ssrByEntries?.[name]))
    ) {
      chain.entryPoints.delete(name);
    }
  });
}

async function applySSRLoaderEntry<B extends Bundler>(
  chain: BundlerChain,
  optinos: BuilderOptions<B>,
  isServer: boolean,
) {
  const { appContext } = optinos;
  const { internalDirectory } = appContext;
  const { entrypoints } = appContext;

  await Promise.all(
    entrypoints.map(async entrypoint => {
      const { entryName } = entrypoint;
      const serverLoadersFile = getServerCombinedModueFile(
        internalDirectory,
        entryName,
      );
      // the rspack is not support virtualModule
      // so we write the combinedModule in filesystem;
      // then we load it from disk;
      if (isServer) {
        // docs: https://nodejs.org/docs/latest-v16.x/api/fs.html#fsexistspath-callback
        // In node.js docs, fs.access() is recommended instead of fs.exists().
        // the one reason is is will occur a race condition, since other processes may change the file's state between the two calls.
        //
        // > Using fs.exists() to check for the existence of a file before calling fs.open(), fs.readFile(), or fs.writeFile() is not recommended.
        // > Doing so introduces a race condition, since other processes may change the file's state between the two calls.
        // > Instead, user code should open/read/write the file directly and handle the error raised if the file does not exist.
        try {
          await fs.access(serverLoadersFile, fs.constants.F_OK);
          // if here is not occur error, it's means the file exists.
          chain.entry(`${entryName}-server-loaders`).add(serverLoadersFile);
        } catch (err) {
          // ignore the error
        }
      }
    }),
  );
}