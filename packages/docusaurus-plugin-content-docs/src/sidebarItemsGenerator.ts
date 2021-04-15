/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  SidebarItem,
  SidebarItemDoc,
  SidebarItemCategory,
  SidebarItemsGenerator,
  SidebarItemsGeneratorDoc,
} from './types';
import {sortBy, take, last, orderBy} from 'lodash';
import {addTrailingSlash, posixPath} from '@docusaurus/utils';
import {Joi} from '@docusaurus/utils-validation';
import {extractNumberPrefix} from './numberPrefix';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import Yaml from 'js-yaml';
import {DefaultCategoryCollapsedValue} from './sidebars';

const BreadcrumbSeparator = '/';

export const CategoryMetadataFilenameBase = '_category_';
export const CategoryMetadataFilenamePattern = '_category_.{json,yml,yaml}';

export type CategoryMetadatasFile = {
  label?: string;
  position?: number;
  collapsed?: boolean;

  // TODO should we allow "items" here? how would this work? would an "autogenerated" type be allowed?
  // This mkdocs plugin do something like that: https://github.com/lukasgeiter/mkdocs-awesome-pages-plugin/
  // cf comment: https://github.com/facebook/docusaurus/issues/3464#issuecomment-784765199
};

type WithPosition = {position?: number};
type SidebarItemWithPosition = SidebarItem & WithPosition;

const CategoryMetadatasFileSchema = Joi.object<CategoryMetadatasFile>({
  label: Joi.string().optional(),
  position: Joi.number().optional(),
  collapsed: Joi.boolean().optional(),
});

// TODO later if there is `CategoryFolder/index.md`, we may want to read the metadata as yaml on it
// see https://github.com/facebook/docusaurus/issues/3464#issuecomment-818670449
async function readCategoryMetadatasFile(
  categoryDirPath: string,
): Promise<CategoryMetadatasFile | null> {
  function assertCategoryMetadataFile(
    content: unknown,
  ): asserts content is CategoryMetadatasFile {
    Joi.attempt(content, CategoryMetadatasFileSchema);
  }

  async function tryReadFile(
    fileNameWithExtension: string,
    parse: (content: string) => unknown,
  ): Promise<CategoryMetadatasFile | null> {
    // Simpler to use only posix paths for mocking file metadatas in tests
    const filePath = posixPath(
      path.join(categoryDirPath, fileNameWithExtension),
    );
    if (await fs.pathExists(filePath)) {
      const contentString = await fs.readFile(filePath, {encoding: 'utf8'});
      const unsafeContent: unknown = parse(contentString);
      try {
        assertCategoryMetadataFile(unsafeContent);
        return unsafeContent;
      } catch (e) {
        console.error(
          chalk.red(
            `The docs sidebar category metadata file looks invalid!\nPath=${filePath}`,
          ),
        );
        throw e;
      }
    }
    return null;
  }

  return (
    (await tryReadFile(`${CategoryMetadataFilenameBase}.json`, JSON.parse)) ??
    (await tryReadFile(`${CategoryMetadataFilenameBase}.yml`, Yaml.load)) ??
    // eslint-disable-next-line no-return-await
    (await tryReadFile(`${CategoryMetadataFilenameBase}.yaml`, Yaml.load))
  );
}

// [...parents, tail]
function parseBreadcrumb(
  breadcrumb: string[],
): {parents: string[]; tail: string} {
  return {
    parents: take(breadcrumb, breadcrumb.length - 1),
    tail: last(breadcrumb)!,
  };
}

// Comment for this feature: https://github.com/facebook/docusaurus/issues/3464#issuecomment-818670449
export const DefaultSidebarItemsGenerator: SidebarItemsGenerator = async function defaultSidebarItemsGenerator({
  item,
  docs: allDocs,
  version,
}): Promise<SidebarItem[]> {
  // Doc at the root of the autogenerated sidebar dir
  function isRootDoc(doc: SidebarItemsGeneratorDoc) {
    return doc.sourceDirName === item.dirName;
  }

  // Doc inside a subfolder of the autogenerated sidebar dir
  function isCategoryDoc(doc: SidebarItemsGeneratorDoc) {
    if (isRootDoc(doc)) {
      return false;
    }

    return (
      // autogen dir is . and doc is in subfolder
      item.dirName === '.' ||
      // autogen dir is not . and doc is in subfolder
      // "api/myDoc" startsWith "api/" (note "api2/myDoc" is not included)
      doc.sourceDirName.startsWith(addTrailingSlash(item.dirName))
    );
  }

  function isInAutogeneratedDir(doc: SidebarItemsGeneratorDoc) {
    return isRootDoc(doc) || isCategoryDoc(doc);
  }

  // autogenDir=a/b and docDir=a/b/c/d => returns c/d
  // autogenDir=a/b and docDir=a/b => returns .
  function getDocDirRelativeToAutogenDir(
    doc: SidebarItemsGeneratorDoc,
  ): string {
    if (!isInAutogeneratedDir(doc)) {
      throw new Error(
        'getDocDirRelativeToAutogenDir() can only be called for  subdocs of the sidebar autogen dir',
      );
    }
    // Is there a node API to compare 2 relative paths more easily?
    // path.relative() does not give good results
    if (item.dirName === '.') {
      return doc.sourceDirName;
    } else if (item.dirName === doc.sourceDirName) {
      return '.';
    } else {
      return doc.sourceDirName.replace(addTrailingSlash(item.dirName), '');
    }
  }

  // Get only docs in the autogen dir
  // Sort by folder+filename at once
  const docs = sortBy(allDocs.filter(isInAutogeneratedDir), (d) => d.source);

  if (docs.length === 0) {
    console.warn(
      chalk.yellow(
        `No docs found in dir ${item.dirName}: can't auto-generate a sidebar`,
      ),
    );
  }

  function createDocSidebarItem(
    doc: SidebarItemsGeneratorDoc,
  ): SidebarItemDoc & WithPosition {
    return {
      type: 'doc',
      id: doc.id,
      ...(doc.frontMatter.sidebar_label && {
        label: doc.frontMatter.sidebar_label,
      }),
      ...(typeof doc.sidebarPosition !== 'undefined' && {
        position: doc.sidebarPosition,
      }),
    };
  }

  async function createCategorySidebarItem({
    breadcrumb,
  }: {
    breadcrumb: string[];
  }): Promise<SidebarItemCategory & WithPosition> {
    const categoryDirPath = path.join(
      version.contentPath,
      breadcrumb.join(BreadcrumbSeparator),
    );

    const categoryMetadatas = await readCategoryMetadatasFile(categoryDirPath);

    const {tail} = parseBreadcrumb(breadcrumb);

    const {filename, numberPrefix} = extractNumberPrefix(tail);

    const position = categoryMetadatas?.position ?? numberPrefix;

    return {
      type: 'category',
      label: categoryMetadatas?.label ?? filename,
      items: [],
      collapsed: categoryMetadatas?.collapsed ?? DefaultCategoryCollapsedValue,
      ...(typeof position !== 'undefined' && {position}),
    };
  }

  // Not sure how to simplify this algorithm :/
  async function autogenerateSidebarItems(): Promise<
    SidebarItemWithPosition[]
  > {
    const sidebarItems: SidebarItem[] = []; // mutable result

    const categoriesByBreadcrumb: Record<string, SidebarItemCategory> = {}; // mutable cache of categories already created

    async function getOrCreateCategoriesForBreadcrumb(
      breadcrumb: string[],
    ): Promise<SidebarItemCategory | null> {
      if (breadcrumb.length === 0) {
        return null;
      }
      const {parents} = parseBreadcrumb(breadcrumb);
      const parentCategory = await getOrCreateCategoriesForBreadcrumb(parents);
      const existingCategory =
        categoriesByBreadcrumb[breadcrumb.join(BreadcrumbSeparator)];

      if (existingCategory) {
        return existingCategory;
      } else {
        const newCategory = await createCategorySidebarItem({
          breadcrumb,
        });
        if (parentCategory) {
          parentCategory.items.push(newCategory);
        } else {
          sidebarItems.push(newCategory);
        }
        categoriesByBreadcrumb[
          breadcrumb.join(BreadcrumbSeparator)
        ] = newCategory;
        return newCategory;
      }
    }

    // Get the category breadcrumb of a doc (relative to the dir of the autogenerated sidebar item)
    function getRelativeBreadcrumb(doc: SidebarItemsGeneratorDoc): string[] {
      const relativeDirPath = getDocDirRelativeToAutogenDir(doc);
      if (relativeDirPath === '.') {
        return [];
      } else {
        return relativeDirPath.split(BreadcrumbSeparator);
      }
    }

    async function handleDocItem(doc: SidebarItemsGeneratorDoc): Promise<void> {
      const breadcrumb = getRelativeBreadcrumb(doc);
      const category = await getOrCreateCategoriesForBreadcrumb(breadcrumb);

      const docSidebarItem = createDocSidebarItem(doc);
      if (category) {
        category.items.push(docSidebarItem);
      } else {
        sidebarItems.push(docSidebarItem);
      }
    }

    // async process made sequential on purpose! order matters
    for (const doc of docs) {
      // eslint-disable-next-line no-await-in-loop
      await handleDocItem(doc);
    }

    return sidebarItems;
  }

  const sidebarItems = await autogenerateSidebarItems();

  return sortSidebarItems(sidebarItems);
};

// Recursively sort the categories/docs + remove the "position" attribute from final output
// Note: the "position" is only used to sort "inside" a sidebar slice
// It is not used to sort across multiple consecutive sidebar slices (ie a whole Category composed of multiple autogenerated items)
function sortSidebarItems(
  sidebarItems: SidebarItemWithPosition[],
): SidebarItem[] {
  const processedSidebarItems = sidebarItems.map((item) => {
    if (item.type === 'category') {
      return {
        ...item,
        items: sortSidebarItems(item.items),
      };
    }
    return item;
  });

  const sortedSidebarItems = orderBy(
    processedSidebarItems,
    (item) => item.position,
    ['asc'],
  );

  return sortedSidebarItems.map(({position: _removed, ...item}) => item);
}
