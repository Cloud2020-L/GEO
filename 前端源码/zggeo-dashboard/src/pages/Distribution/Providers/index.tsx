import React from 'react';
import { Button, Card, Col, Input, Row, Space, Tag } from 'tdesign-react';
import Style from '../linear.module.less';

const providers = [
  {
    name: '新榜矩阵通',
    status: '重点对接',
    scope: '企业级新媒体矩阵管理、账号规模化治理、数据分析、AI/合规能力、品牌/政企账号矩阵',
    website: 'https://matrix.newrank.cn/',
    scene: '大型品牌、上市公司、政务文旅、连锁门店、上万级账号矩阵',
    api: '商务开通 / API 待确认',
  },
  {
    name: '云略',
    status: '重点对接',
    scope: 'API 对接、私有化部署、AI 生成到中台发布自动化链路',
    website: '',
    scene: '适合 ZGEO 后续做 AI 自媒体发布中台：AI生成 → 中台API → 自动发布',
    api: 'API 对接优先 / 私有化部署优先',
  },
  { name: '蚁小二', status: '待商务开通', scope: '账号管理、文章发布、状态查询、数据回收' },
  { name: '融媒宝', status: '待商务开通', scope: '媒体市场、自媒体分发、发布回执、数据统计' },
  { name: '手动发布', status: '已启用', scope: '生成投稿包、复制发布、人工回填链接' },
];

const Providers: React.FC = () => (
  <div className={Style.page}>
    <Card bordered={false} className={Style.heroCard}>
      <Space direction='vertical'>
        <Space>
          <Tag theme='primary' variant='light'>
            第三方平台配置
          </Tag>
          <Tag theme='warning' variant='light'>
            API 适配层
          </Tag>
        </Space>
        <div className={Style.heroTitle}>蚁小二 / 融媒宝接入配置</div>
        <div className={Style.heroDesc}>
          先把 appKey、appSecret、回调地址、发布接口、状态查询接口都预留好；拿到 API 文档即可接通。
        </div>
      </Space>
    </Card>
    <Row gutter={[16, 16]}>
      {providers.map((item) => (
        <Col xs={12} lg={4} key={item.name}>
          <Card bordered={false} title={item.name} className={Style.itemCard}>
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space style={{ flexWrap: 'wrap' }}>
                <Tag
                  theme={item.status === '已启用' ? 'success' : item.status === '重点对接' ? 'primary' : 'warning'}
                  variant='light'
                >
                  {item.status}
                </Tag>
                {'api' in item && (
                  <Tag theme='default' variant='light'>
                    {item.api}
                  </Tag>
                )}
              </Space>
              <div className={Style.itemDesc}>{item.scope}</div>
              {'scene' in item && <div className={Style.subtleText}>适配场景：{item.scene}</div>}
              {'website' in item && item.website && (
                <a href={item.website} target='_blank' rel='noreferrer'>
                  打开官网 / 产品页
                </a>
              )}
              <Input placeholder='App Key / Client ID' />
              <Input placeholder='App Secret / Token' type='password' />
              <Input placeholder='Webhook 回调地址' />
              <Input placeholder='发布接口 Base URL' />
              <Button theme='primary'>保存配置</Button>
            </Space>
          </Card>
        </Col>
      ))}
    </Row>
  </div>
);

export default Providers;
