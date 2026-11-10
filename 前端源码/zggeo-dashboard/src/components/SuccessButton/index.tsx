import React from 'react';
import classNames from 'classnames';
import { Button, ButtonProps } from 'tdesign-react';
import { CheckCircleFilledIcon } from 'tdesign-icons-react';

import Style from './index.module.less';

export interface SuccessButtonProps extends ButtonProps {
  success?: boolean;
  successText?: React.ReactNode;
}

const SuccessButton = ({
  children,
  className,
  icon,
  loading,
  success = false,
  successText,
  ...rest
}: SuccessButtonProps) => {
  const resolvedIcon = success ? <CheckCircleFilledIcon /> : icon;
  const resolvedChildren = success ? successText ?? children : children;

  return (
    <Button
      {...rest}
      className={classNames(Style.successButton, className, {
        [Style.idle]: !success,
        [Style.success]: success,
      })}
      icon={resolvedIcon}
      loading={success ? false : loading}
      theme='default'
      variant='base'
    >
      {resolvedChildren}
    </Button>
  );
};

export default React.memo(SuccessButton);
