import { lazy } from 'react';
import { EditIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const contentGeneration: IRouter[] = [
  {
    path: '/content-generation',
    meta: {
      title: '内容生成',
      Icon: EditIcon,
    },
    children: [
      {
        path: 'images',
        Component: lazy(() => import('pages/Content/ImagesNew')),
        meta: {
          title: '素材图片',
        },
      },
      {
        path: 'articles-new',
        Component: lazy(() => import('pages/Content/ArticlesNew')),
        meta: {
          title: '文章生成NEW',
        },
      },
      {
        path: 'articles',
        Component: lazy(() => import('pages/Content/ArticleLibrary')),
        meta: {
          title: '文章库',
        },
      },
    ],
  },
];

export default contentGeneration;
