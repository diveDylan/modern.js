import path from 'path';
import { GeneratorContext, GeneratorCore } from '@modern-js/codesmith';
import { AppAPI } from '@modern-js/codesmith-api-app';
import { JsonAPI } from '@modern-js/codesmith-api-json';
import {
  ora,
  getAvailableVersion,
  getModernVersion,
  getPackageManager,
  getPackageObj,
  execa,
} from '@modern-js/generator-utils';
import {
  PackageManager,
  Solution,
  SolutionText,
  SolutionToolsMap,
} from '@modern-js/generator-common';
import { i18n, localeKeys } from './locale';

export const handleTemplateFile = async (
  context: GeneratorContext,
  generator: GeneratorCore,
) => {
  const jsonAPI = new JsonAPI(generator);
  // get project solution type
  const pkgInfo = await getPackageObj(context);
  const deps = {
    ...pkgInfo.devDependencies,
    ...pkgInfo.dependencies,
  };
  const solutions = Object.keys(SolutionToolsMap).filter(
    solution => deps[SolutionToolsMap[solution as Solution]],
  );
  if (solutions.length === 0) {
    throw Error(i18n.t(localeKeys.tooltip.no_solution));
  }
  if (solutions.length >= 2) {
    throw Error(i18n.t(localeKeys.tooltip.more_solution));
  }

  generator.logger.info(
    `[${i18n.t(localeKeys.projectType)}]: ${SolutionText[
      solutions[0] as Solution
    ]()}`,
  );

  // get modern latest version
  const modernVersion = await getModernVersion(
    solutions[0] as Solution,
    context.config.registry,
  );

  generator.logger.info(
    `[${i18n.t(localeKeys.modernVersion)}]: ${modernVersion}`,
  );

  const appDir = context.materials.default.basePath;

  const packageManager = await getPackageManager(appDir);
  context.config.packageManager = packageManager;

  if (solutions[0] === Solution.Monorepo) {
    if (packageManager === PackageManager.Pnpm) {
      await execa(
        'pnpm',
        ['update', '@modern-js/*', '--recursive', '--latest'],
        {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
    } else {
      await execa('yarn', ['upgrade', '--scope', '@modern-js/*', '--latest'], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
    }
    return;
  }

  const modernDeps = Object.keys(pkgInfo.dependencies || {}).filter(
    dep => dep.startsWith('@modern-js') || dep.startsWith('@modern-js-app'),
  );
  const modernDevDeps = Object.keys(pkgInfo.devDependencies || {}).filter(
    dep => dep.startsWith('@modern-js') || dep.startsWith('@modern-js-app'),
  );
  const updateInfo: Record<string, string> = {};

  const spinner = ora('Loading...').start();
  spinner.color = 'yellow';

  await Promise.all(
    modernDeps.map(
      async dep =>
        (updateInfo[`dependencies.${dep}`] = await getAvailableVersion(
          dep,
          modernVersion,
        )),
    ),
  );

  await Promise.all(
    modernDevDeps.map(
      async dep =>
        (updateInfo[`devDependencies.${dep}`] = await getAvailableVersion(
          dep,
          modernVersion,
        )),
    ),
  );
  await jsonAPI.update(
    context.materials.default.get(path.join(appDir, 'package.json')),
    {
      query: {},
      update: {
        $set: updateInfo,
      },
    },
  );

  spinner.stop();
};

export default async (context: GeneratorContext, generator: GeneratorCore) => {
  const appApi = new AppAPI(context, generator);

  const { locale } = context.config;
  appApi.i18n.changeLanguage({ locale });

  generator.logger.debug(`start run @modern-js/upgrade-generator`);
  generator.logger.debug(`context=${JSON.stringify(context)}`);
  generator.logger.debug(`context.data=${JSON.stringify(context.data)}`);

  await handleTemplateFile(context, generator);

  await appApi.runInstall();

  appApi.showSuccessInfo(i18n.t(localeKeys.success));

  generator.logger.debug(`forge @modern-js/upgrade-generator succeed `);
};