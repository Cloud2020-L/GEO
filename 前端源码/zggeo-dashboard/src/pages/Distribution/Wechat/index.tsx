import React from 'react';
import { Button, Card, Col, Row, Space, Tag } from 'tdesign-react';
import Style from '../linear.module.less';

const Wechat: React.FC = () => (
  <div className={Style.page}>
    <Card bordered={false} className={Style.heroCard}>
      <Space direction='vertical'>
        <Space>
          <Tag theme='success' variant='light'>
            公众号发稿
          </Tag>
          <Tag theme='primary' variant='light'>
            草稿箱 API 预留
          </Tag>
        </Space>
        <div className={Style.heroTitle}>公众号发稿中心</div>
        <div className={Style.heroDesc}>
          公众号单独管理：授权、图文素材、草稿箱、群发审核、发布链接和阅读数据。后续接微信官方接口。
        </div>
      </Space>
    </Card>
    <Row gutter={[16, 16]}>
      {['公众号授权', '图文草稿', '发布计划', '阅读数据'].map((title) => (
        <Col xs={12} lg={3} key={title}>
          <Card bordered={false} className={Style.itemCard}>
            <Space direction='vertical'>
              <span className={Style.itemTitle}>{title}</span>
              <div className={Style.itemDesc}>API 待开通，当前可做人工审核和投放记录。</div>
              <Button theme='primary' variant='outline'>
                进入
              </Button>
            </Space>
          </Card>
        </Col>
      ))}
    </Row>
  </div>
);

export default Wechat;
