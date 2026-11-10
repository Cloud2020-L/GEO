import { lazy } from 'react';
import { EditIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const content: IRouter[] = [
  {
    path: '/content',
    meta: {
      title: '内容生产',
      Icon: EditIcon,
    },
    children: [
      {
        path: 'tasks',
        Component: lazy(() => import('pages/Content/Tasks')),
        meta: {
          title: '写作任务池',
        },
      },
      {
        path: 'prompts',
        Component: lazy(() => import('pages/Content/Prompts')),
        meta: {
          title: 'Prompt 库',
        },
      },
      {
        path: 'knowledge',
        Component: lazy(() => import('pages/Content/Knowledge')),
        meta: {
          title: '品牌知识库',
        },
      },
      {
        path: 'images',
        Component: lazy(() => import('pages/Content/Images')),
        meta: {
          title: '图片管理',
        },
      },
      {
        path: 'generate',
        Component: lazy(() => import('pages/Content/Generate')),
        meta: {
          title: '文章生成',
        },
      },
    ],
  },
];

export default content;
