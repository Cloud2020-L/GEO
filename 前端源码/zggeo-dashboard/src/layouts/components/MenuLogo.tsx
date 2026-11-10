import React, { memo } from 'react';
import Style from './Menu.module.less';
import { useNavigate } from 'react-router-dom';

interface IProps {
  collapsed?: boolean;
}

export default memo((props: IProps) => {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate('/');
  };

  if (props.collapsed) {
    return (
      <div className={Style.menuLogoMini} onClick={handleClick} title='智改GEO 指挥中枢'>
        <span className={Style.menuLogoMiniAccent}>Z</span>
      </div>
    );
  }

  return (
    <div className={Style.menuLogo} onClick={handleClick}>
      <div className={Style.menuLogoWordmark}>
        <span className={Style.menuLogoAccent}>zg</span>
        <span className={Style.menuLogoText}>geo</span>
      </div>
      <div className={Style.menuLogoSubtitle}>智改GEO 指挥中枢</div>
      <div className={Style.menuLogoMeta}>Powered by Phantom OS</div>
    </div>
  );
});
