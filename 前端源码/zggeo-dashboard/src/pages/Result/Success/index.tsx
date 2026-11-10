import React, { memo } from 'react';
import { Button } from 'tdesign-react';
import { CheckCircleIcon } from 'tdesign-icons-react';
import SuccessButton from 'components/SuccessButton';

import style from './index.module.less';

const Success = () => (
  <div className={style.Content}>
    <CheckCircleIcon className={style.icon} />
    <div className={style.title}>项目已创建成功</div>
    <div className={style.description}>可以联系负责人分发应用</div>
    <div>
      <SuccessButton>返回首页</SuccessButton>
      <Button className={style.rightButton} theme='default'>
        查看进度
      </Button>
      <SuccessButton className={style.rightButton} success successText='已同步成功' />
    </div>
  </div>
);

export default memo(Success);
