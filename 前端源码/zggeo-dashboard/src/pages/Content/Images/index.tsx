import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Form,
  Input,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { AddIcon, DeleteIcon, EditIcon, ImageIcon, RefreshIcon, UploadIcon } from 'tdesign-icons-react';
import {
  createImageGroupDb,
  deleteImageGroupDb,
  deleteManagedImageDb,
  Lead,
  listImageGroupsDb,
  listManagedImagesDb,
  listSelectableLeads,
  updateImageGroupDb,
  uploadManagedImageDb,
  type ContentImageGroup,
  type ContentImageRow,
} from 'services/zggeo-api';
import {
  createLocalId,
  deleteImageBlob,
  loadImageBlobUrl,
  loadProtectedImageUrl,
  readFallbackGroups,
  readFallbackImages,
  saveImageBlob,
  StoredImageGroup,
  StoredManagedImage,
  writeFallbackGroups,
  writeFallbackImages,
} from 'utils/contentImageStore';
import Style from '../linear.module.less';

const { FormItem } = Form;

export interface ImageGroup {
  id: string;
  lead_id?: string;
  lead_name?: string;
  name: string;
  description?: string;
  usage?: 'article' | 'product' | 'case' | 'banner' | 'other';
  created_at: string;
  updated_at?: string;
  image_count?: number;
  is_local_only?: boolean;
}

export interface ManagedImage {
  id: string;
  group_id: string;
  lead_id?: string;
  group_name: string;
  name: string;
  alt: string;
  url: string;
  file_url?: string;
  mime_type?: string;
  size?: number;
  created_at: string;
  storage?: 'backend' | 'indexeddb';
  indexeddb_key?: string;
  is_local_only?: boolean;
}

const formatLeadLabel = (lead: Lead) => {
  const company = String(lead.company || '').trim();
  const brand = String(lead.brand_name || '').trim();
  const domain = String(lead.domain || '').trim();
  const name = String(lead.name || '').trim();
  return `${brand || company || name || '未命名客户'}${domain ? ` · ${domain}` : ''}`;
};

const assetGroupName = (lead: Lead) =>
  String(lead.brand_name || lead.company || lead.name || '')
    .trim()
    .slice(0, 48);

const normalizeSelectValue = (value: unknown): string => {
  if (Array.isArray(value)) return normalizeSelectValue(value[0]);
  if (value && typeof value === 'object') {
    const item = value as { value?: unknown; id?: unknown };
    return String(item.value ?? item.id ?? '').trim();
  }
  return String(value || '').trim();
};

const normalizeFileUrl = (url: unknown) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('http') || value.startsWith('blob:') || value.startsWith('data:') || value.startsWith('/')) {
    return value;
  }
  return `/api/zggeo${value.startsWith('/') ? value : `/${value}`}`;
};

const mapBackendGroup = (group: ContentImageGroup): ImageGroup => ({
  id: String(group.id || ''),
  lead_id: group.lead_id ? String(group.lead_id) : undefined,
  lead_name: String(group.lead_name || '').trim() || undefined,
  name: String(group.name || '未命名图片组').trim(),
  description: String(group.description || '').trim(),
  usage: group.usage || 'article',
  image_count: Number(group.image_count || 0),
  created_at: String(group.created_at || new Date().toISOString()),
  updated_at: group.updated_at,
});

const mapBackendImage = (image: ContentImageRow): ManagedImage => ({
  id: String(image.id || ''),
  group_id: String(image.group_id || ''),
  lead_id: image.lead_id ? String(image.lead_id) : undefined,
  group_name: String(image.group_name || '未分组图片').trim(),
  name: String(image.name || '未命名图片').trim(),
  alt: String(image.alt || image.name || '文章配图')
    .replace(/\.[^.]+$/, '')
    .trim(),
  url: normalizeFileUrl(image.file_url),
  file_url: normalizeFileUrl(image.file_url),
  mime_type: image.mime_type,
  size: Number(image.size || 0),
  storage: 'backend',
  created_at: String(image.created_at || new Date().toISOString()),
});

const mapFallbackGroup = (group: StoredImageGroup): ImageGroup => ({
  id: String(group.id || ''),
  lead_id: group.lead_id ? String(group.lead_id) : undefined,
  lead_name: String(group.lead_name || '').trim() || undefined,
  name: String(group.name || '未命名图片组').trim(),
  description: String(group.description || '').trim(),
  usage: (group.usage as ImageGroup['usage']) || 'article',
  created_at: String(group.created_at || new Date().toISOString()),
  updated_at: group.updated_at,
  image_count: Number(group.image_count || 0),
  is_local_only: true,
});

const shouldUseIndexedDbFallback = (err: any) => {
  const status = Number(err?.response?.status || 0);
  return !status || status === 404 || status === 405;
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered={false} className={Style.statCard}>
    <div className={Style.statLabel}>{title}</div>
    <div className={Style.statValue} style={color ? { color } : undefined}>
      {value}
    </div>
  </Card>
);

const Images: React.FC = () => {
  const [groups, setGroups] = useState<ImageGroup[]>([]);
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [editingGroupId, setEditingGroupId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedLeadFilter, setSelectedLeadFilter] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [leadLoading, setLeadLoading] = useState(false);
  const [materialLoading, setMaterialLoading] = useState(false);
  const [usingLocalFallback, setUsingLocalFallback] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const leadOptions = useMemo(
    () => leads.map((lead) => ({ label: formatLeadLabel(lead), value: String(lead.id) })),
    [leads],
  );
  const findLead = (leadId: string) => leads.find((item) => String(item.id) === leadId);
  const formatLeadNameById = (leadId: string) =>
    findLead(leadId)
      ? formatLeadLabel(findLead(leadId) as Lead)
      : leadOptions.find((item) => item.value === leadId)?.label || leadId;
  const visibleGroups = useMemo(
    () => groups.filter((group) => !selectedLeadFilter || String(group.lead_id || '') === selectedLeadFilter),
    [groups, selectedLeadFilter],
  );

  const loadLeadOptions = async () => {
    setLeadLoading(true);
    try {
      setLeads(await listSelectableLeads());
    } catch (err: any) {
      MessagePlugin.error(`客户资产加载失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    } finally {
      setLeadLoading(false);
    }
  };

  const loadFallbackMaterials = async () => {
    const fallbackGroups = readFallbackGroups().map(mapFallbackGroup);
    const fallbackImages = await Promise.all(
      readFallbackImages().map(async (image) => ({
        id: String(image.id || ''),
        group_id: String(image.group_id || ''),
        lead_id: image.lead_id ? String(image.lead_id) : undefined,
        group_name: String(image.group_name || '未分组图片'),
        name: String(image.name || '未命名图片'),
        alt: String(image.alt || image.name || '文章配图'),
        url:
          normalizeFileUrl(image.file_url) ||
          (await loadImageBlobUrl(image.indexeddb_key)) ||
          normalizeFileUrl(image.url),
        file_url: normalizeFileUrl(image.file_url),
        mime_type: image.mime_type,
        size: Number(image.size || 0),
        created_at: String(image.created_at || new Date().toISOString()),
        storage: image.storage || 'indexeddb',
        indexeddb_key: image.indexeddb_key,
        is_local_only: true,
      })),
    );
    setGroups(fallbackGroups);
    setImages(fallbackImages);
    setUsingLocalFallback(fallbackGroups.length > 0 || fallbackImages.length > 0);
  };

  const loadMaterialData = async () => {
    setMaterialLoading(true);
    try {
      const [groupRows, imageRows] = await Promise.all([listImageGroupsDb(), listManagedImagesDb()]);
      const backendImages = await Promise.all(
        imageRows.map(async (row) => {
          const image = mapBackendImage(row);
          return {
            ...image,
            url: (await loadProtectedImageUrl(image.file_url || image.url)) || image.url,
          };
        }),
      );
      setGroups(groupRows.map(mapBackendGroup));
      setImages(backendImages);
      setUsingLocalFallback(false);
    } catch (err: any) {
      await loadFallbackMaterials();
      MessagePlugin.warning(
        `图片后端接口暂不可用，已切换到本机 IndexedDB 兜底：${
          err?.response?.data?.detail || err?.message || '请检查后端服务'
        }`,
      );
    } finally {
      setMaterialLoading(false);
    }
  };

  useEffect(() => {
    loadLeadOptions();
    loadMaterialData();
  }, []);

  const visibleImages = useMemo(() => {
    if (selectedGroupId) return images.filter((image) => image.group_id === selectedGroupId);
    if (!selectedLeadFilter) return images;
    const visibleGroupIds = new Set(visibleGroups.map((group) => group.id));
    return images.filter(
      (image) => String(image.lead_id || '') === selectedLeadFilter || visibleGroupIds.has(image.group_id),
    );
  }, [images, selectedGroupId, selectedLeadFilter, visibleGroups]);

  const imageCountByGroup = useMemo(
    () =>
      images.reduce<Record<string, number>>((acc, image) => {
        acc[image.group_id] = (acc[image.group_id] || 0) + 1;
        return acc;
      }, {}),
    [images],
  );

  const currentGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );
  const currentLeadName = selectedLeadFilter ? formatLeadNameById(selectedLeadFilter) : '';
  const imageScopeTitle = currentGroup
    ? `${currentGroup.name} 的组内图片`
    : selectedLeadFilter
    ? `${currentLeadName} 的全部图片`
    : '全部图片';
  const uploadTargetHint = currentGroup
    ? `将导入到图片组：${currentGroup.name}${currentGroup.lead_name ? ` · ${currentGroup.lead_name}` : ''}`
    : '请先在表格中点击「查看」选择图片组';
  const getImageGroup = (image: ManagedImage) => groups.find((group) => group.id === image.group_id);
  const getImageLeadName = (image: ManagedImage) => {
    const group = getImageGroup(image);
    if (group?.lead_name) return group.lead_name;
    if (image.lead_id) return formatLeadNameById(image.lead_id);
    return '未绑定客户资产';
  };

  const openCreateGroup = () => {
    setEditingGroupId('');
    setSelectedAssetId(selectedLeadFilter);
    setGroupName('');
    setGroupDescription('');
    setGroupOpen(true);
  };

  const openEditGroup = (group: ImageGroup) => {
    setEditingGroupId(group.id);
    setSelectedAssetId(String(group.lead_id || ''));
    setGroupName(group.name);
    setGroupDescription(group.description || '');
    setGroupOpen(true);
  };

  const selectAssetForGroup = (value: unknown) => {
    const leadId = normalizeSelectValue(value);
    setSelectedAssetId(leadId);
    const lead = findLead(leadId);
    if (!lead) return;
    const name = assetGroupName(lead);
    if (name) setGroupName(name);
    setGroupDescription(
      [
        String(lead.domain || '').trim() && `官网：${lead.domain}`,
        String(lead.company || '').trim() && `公司：${lead.company}`,
        '用途：文章配图素材组',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  };

  const saveGroup = async () => {
    const name = groupName.trim();
    const leadId = normalizeSelectValue(selectedAssetId) || selectedLeadFilter;
    if (!leadId) {
      MessagePlugin.warning('请先选择客户资产');
      return;
    }
    const lead = findLead(leadId);
    if (!name) {
      MessagePlugin.warning('请填写图片组名称');
      return;
    }
    if (
      groups.some(
        (group) => group.name === name && String(group.lead_id || '') === leadId && group.id !== editingGroupId,
      )
    ) {
      MessagePlugin.warning('这个客户资产下已经存在同名图片组');
      return;
    }
    const now = new Date().toISOString();
    const leadName = lead ? formatLeadLabel(lead) : formatLeadNameById(leadId);
    try {
      if (editingGroupId) {
        const current = groups.find((group) => group.id === editingGroupId);
        if (current?.is_local_only || usingLocalFallback) {
          const nextGroups = groups.map((group) =>
            group.id === editingGroupId
              ? {
                  ...group,
                  lead_id: leadId,
                  lead_name: leadName,
                  name,
                  description: groupDescription.trim(),
                  updated_at: now,
                  is_local_only: true,
                }
              : group,
          );
          writeFallbackGroups(nextGroups);
          setGroups(nextGroups);
        } else {
          const updated = await updateImageGroupDb(editingGroupId, {
            lead_id: leadId,
            name,
            description: groupDescription.trim(),
            usage: 'article',
          });
          setGroups((prev) => prev.map((group) => (group.id === editingGroupId ? mapBackendGroup(updated) : group)));
        }
        setImages((prev) =>
          prev.map((image) =>
            image.group_id === editingGroupId ? { ...image, lead_id: leadId, group_name: name } : image,
          ),
        );
        MessagePlugin.success('图片组已更新');
        setGroupOpen(false);
        return;
      }

      if (usingLocalFallback) {
        const group = {
          id: createLocalId('group'),
          lead_id: leadId,
          lead_name: leadName,
          name,
          description: groupDescription.trim(),
          usage: 'article' as const,
          created_at: now,
          updated_at: now,
          is_local_only: true,
        };
        const nextGroups = [group, ...groups];
        writeFallbackGroups(nextGroups);
        setGroups(nextGroups);
        setSelectedGroupId(group.id);
        MessagePlugin.warning('图片组仅保存在本机浏览器，建议启用后端持久化');
      } else {
        const group = mapBackendGroup(
          await createImageGroupDb({
            lead_id: leadId,
            name,
            description: groupDescription.trim(),
            usage: 'article',
          }),
        );
        setGroups((prev) => [group, ...prev]);
        setSelectedGroupId(group.id);
        MessagePlugin.success('图片组已创建');
      }
      setSelectedLeadFilter(leadId);
      setSelectedAssetId('');
      setGroupName('');
      setGroupDescription('');
      setGroupOpen(false);
    } catch (err: any) {
      MessagePlugin.error(`图片组保存失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    }
  };

  const uploadImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!selectedGroupId) {
      MessagePlugin.warning('请先选择或创建图片组');
      return;
    }
    const group = groups.find((item) => item.id === selectedGroupId);
    if (!group) return;
    setUploading(true);
    try {
      const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        MessagePlugin.warning('请选择图片文件');
        return;
      }
      const results = await Promise.all(
        imageFiles.map(async (file) => {
          const alt = file.name.replace(/\.[^.]+$/, '');
          try {
            if (group.is_local_only || usingLocalFallback) throw new Error('local fallback enabled');
            const row = await uploadManagedImageDb({
              file,
              group_id: group.id,
              lead_id: String(group.lead_id || ''),
              alt,
            });
            return { status: 'uploaded' as const, image: mapBackendImage(row) };
          } catch (err: any) {
            if (!group.is_local_only && !usingLocalFallback && !shouldUseIndexedDbFallback(err)) {
              return { status: 'failed' as const, file };
            }
            try {
              const id = createLocalId('img');
              const indexeddbKey = `content-image:${id}`;
              await saveImageBlob(indexeddbKey, file);
              const image: ManagedImage = {
                id,
                group_id: group.id,
                lead_id: group.lead_id,
                group_name: group.name,
                name: file.name,
                alt,
                url: URL.createObjectURL(file),
                mime_type: file.type,
                size: file.size,
                storage: 'indexeddb',
                indexeddb_key: indexeddbKey,
                is_local_only: true,
                created_at: new Date().toISOString(),
              };
              return { status: 'local' as const, image };
            } catch {
              return { status: 'failed' as const, file };
            }
          }
        }),
      );
      const uploaded = results
        .filter((item): item is { status: 'uploaded'; image: ManagedImage } => item.status === 'uploaded')
        .map((item) => item.image);
      const localOnly = results
        .filter((item): item is { status: 'local'; image: ManagedImage } => item.status === 'local')
        .map((item) => item.image);
      const failed = results.filter((item) => item.status === 'failed');
      const nextImages = [...uploaded, ...localOnly];
      if (nextImages.length > 0) {
        setImages((prev) => [...nextImages, ...prev]);
        if (localOnly.length > 0) {
          try {
            const fallbackImages: StoredManagedImage[] = [
              ...localOnly.map((image) => ({
                ...image,
                url: undefined,
                storage: 'indexeddb' as const,
                is_local_only: true,
              })),
              ...readFallbackImages(),
            ];
            writeFallbackImages(fallbackImages);
            if (!readFallbackGroups().some((item) => item.id === group.id)) {
              writeFallbackGroups([{ ...group, is_local_only: true }, ...readFallbackGroups()]);
            }
            setUsingLocalFallback(true);
          } catch {
            await Promise.all(localOnly.map((image) => deleteImageBlob(String(image.indexeddb_key || ''))));
            setImages((prev) => prev.filter((image) => !localOnly.some((item) => item.id === image.id)));
            MessagePlugin.error('图片保存失败，当前浏览器本地存储空间不足');
            return;
          }
        }
      }
      if (uploaded.length > 0 && localOnly.length === 0 && failed.length === 0) {
        MessagePlugin.success(`已导入 ${uploaded.length} 张图片`);
      } else if (nextImages.length > 0 && failed.length > 0) {
        MessagePlugin.warning(`成功 ${nextImages.length} 张，失败 ${failed.length} 张`);
      } else if (localOnly.length > 0) {
        MessagePlugin.warning('当前图片仅保存在本机浏览器，建议启用后端持久化');
      } else {
        MessagePlugin.error('上传失败，页面不会新增未保存的图片');
      }
      if (uploaded.length > 0) loadMaterialData();
    } catch (err: any) {
      MessagePlugin.error(`图片导入失败：${err?.message || '未知错误'}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const deleteGroup = async (groupId = selectedGroupId) => {
    if (!groupId) return;
    const group = groups.find((item) => item.id === groupId);
    try {
      if (group?.is_local_only || usingLocalFallback) {
        const deletingImages = images.filter((image) => image.group_id === groupId);
        await Promise.all(deletingImages.map((image) => deleteImageBlob(String(image.indexeddb_key || ''))));
        const nextGroups = groups.filter((item) => item.id !== groupId);
        const nextImages = images.filter((image) => image.group_id !== groupId);
        writeFallbackGroups(nextGroups.filter((item) => item.is_local_only));
        writeFallbackImages(
          nextImages
            .filter((image) => image.is_local_only)
            .map((image) => ({ ...image, url: undefined, storage: 'indexeddb' as const })),
        );
        setGroups(nextGroups);
        setImages(nextImages);
      } else {
        await deleteImageGroupDb(groupId);
        await loadMaterialData();
      }
      if (selectedGroupId === groupId) setSelectedGroupId('');
      MessagePlugin.success('图片组和组内图片已删除');
    } catch (err: any) {
      MessagePlugin.error(`图片组删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    }
  };

  const deleteImage = async (id: string) => {
    const image = images.find((item) => item.id === id);
    if (!image) return;
    try {
      if (image.is_local_only || image.storage === 'indexeddb') {
        await deleteImageBlob(String(image.indexeddb_key || ''));
        const nextImages = images.filter((item) => item.id !== id);
        writeFallbackImages(
          nextImages
            .filter((item) => item.is_local_only)
            .map((item) => ({ ...item, url: undefined, storage: 'indexeddb' as const })),
        );
        setImages(nextImages);
      } else {
        await deleteManagedImageDb(id);
        await loadMaterialData();
      }
      MessagePlugin.success('图片已删除');
    } catch (err: any) {
      MessagePlugin.error(`图片删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    }
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              内容生产
            </Tag>
            <Tag theme='success' variant='light'>
              图片素材库
            </Tag>
          </Space>
          <div className={Style.heroTitle}>图片管理</div>
          <div className={Style.heroDesc}>
            按组管理文章配图。文章生成时可以选择图片，系统会在正文合适位置插入 Markdown 图片。
          </div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='图片组' value={visibleGroups.length} />
        <Metric title='图片总数' value={images.length} color='#00A870' />
        <Metric title='当前组图片' value={visibleImages.length} color='#5E6AD2' />
      </div>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='图片素材'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} loading={materialLoading} onClick={loadMaterialData}>
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreateGroup}>
              创建组
            </Button>
            <Button
              icon={<UploadIcon />}
              loading={uploading}
              disabled={!selectedGroupId}
              onClick={() => inputRef.current?.click()}
            >
              {currentGroup ? `导入到：${currentGroup.name}` : '导入图片'}
            </Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <Select
            value={selectedLeadFilter}
            options={[{ label: '全部客户资产', value: '' }, ...leadOptions]}
            filterable
            clearable
            loading={leadLoading}
            onChange={(value) => {
              const leadId = normalizeSelectValue(value);
              setSelectedLeadFilter(leadId);
              if (leadId && currentGroup?.lead_id !== leadId) setSelectedGroupId('');
            }}
            style={{ width: 300 }}
          />
          <Select
            value={selectedGroupId}
            options={[
              { label: '全部图片', value: '' },
              ...visibleGroups.map((group) => ({ label: group.name, value: group.id })),
            ]}
            onChange={(value) => setSelectedGroupId(normalizeSelectValue(value))}
            style={{ width: 260 }}
          />
          <Popconfirm
            content='确认删除当前图片组？组内图片也会一起删除。'
            onConfirm={() => deleteGroup(selectedGroupId)}
          >
            <Button theme='danger' variant='outline' disabled={!selectedGroupId}>
              删除当前组
            </Button>
          </Popconfirm>
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            multiple
            style={{ display: 'none' }}
            onChange={(event) => uploadImages(event.target.files)}
          />
          <Tag theme={currentGroup ? 'success' : 'warning'} variant='light'>
            {uploadTargetHint}
          </Tag>
          {usingLocalFallback ? (
            <Tag theme='warning' variant='light'>
              当前图片仅保存在本机浏览器，建议启用后端持久化
            </Tag>
          ) : null}
        </Space>

        {currentGroup ? (
          <Card bordered={false} className={Style.itemCard} style={{ marginBottom: 16 }}>
            <Space direction='vertical'>
              <Space>
                <Tag theme='primary' variant='light'>
                  当前导入目标
                </Tag>
                <Tag theme='success' variant='light'>
                  {imageCountByGroup[currentGroup.id] || 0} 张图片
                </Tag>
                {currentGroup.is_local_only ? (
                  <Tag theme='warning' variant='light'>
                    本机兜底
                  </Tag>
                ) : null}
                {currentGroup.lead_name ? <Tag variant='light'>{currentGroup.lead_name}</Tag> : null}
              </Space>
              <div className={Style.itemTitle}>{currentGroup.name}</div>
              <div className={Style.subtleText}>导入图片会保存到这个图片组中。</div>
              <div className={Style.subtleText}>{currentGroup.description || '暂无说明'}</div>
            </Space>
          </Card>
        ) : (
          <Card bordered={false} className={Style.itemCard} style={{ marginBottom: 16 }}>
            <Space direction='vertical'>
              <Tag theme='warning' variant='light'>
                未选择导入组
              </Tag>
              <div className={Style.itemTitle}>请先选择图片组</div>
              <div className={Style.subtleText}>在下方图片组列表点击「查看」，再导入图片。</div>
            </Space>
          </Card>
        )}

        <Table
          rowKey='id'
          data={visibleGroups}
          loading={materialLoading}
          columns={[
            {
              colKey: 'lead_name',
              title: '客户资产',
              ellipsis: true,
              cell: ({ row }) => row.lead_name || '未绑定',
            },
            {
              colKey: 'name',
              title: '组名称',
              ellipsis: true,
              cell: ({ row }) => (
                <Space size={6}>
                  <span>{row.name}</span>
                  {row.id === selectedGroupId ? (
                    <Tag theme='primary' variant='light'>
                      当前导入组
                    </Tag>
                  ) : null}
                </Space>
              ),
            },
            { colKey: 'description', title: '组说明', ellipsis: true, cell: ({ row }) => row.description || '-' },
            {
              colKey: 'count',
              title: '图片数',
              width: 100,
              cell: ({ row }) => <Tag variant='light'>{imageCountByGroup[row.id] || 0}</Tag>,
            },
            {
              colKey: 'created_at',
              title: '创建时间',
              width: 180,
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'action',
              title: '组操作',
              width: 210,
              cell: ({ row }) => (
                <Space>
                  <Button
                    size='small'
                    variant='text'
                    theme={row.id === selectedGroupId ? 'primary' : 'default'}
                    disabled={row.id === selectedGroupId}
                    onClick={() => setSelectedGroupId(row.id)}
                  >
                    {row.id === selectedGroupId ? '当前查看中' : '查看'}
                  </Button>
                  <Button size='small' variant='text' icon={<EditIcon />} onClick={() => openEditGroup(row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    content={`确认删除“${row.name}”？组内 ${imageCountByGroup[row.id] || 0} 张图片也会一起删除。`}
                    onConfirm={() => deleteGroup(row.id)}
                  >
                    <Button size='small' variant='text' theme='danger'>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          pagination={{ pageSize: 5 }}
        />

        <div style={{ marginTop: 18 }}>
          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className={Style.itemTitle}>{imageScopeTitle}</div>
            <div className={Style.subtleText}>当前显示 {visibleImages.length} 张</div>
          </Space>

          {visibleImages.length === 0 ? (
            <div className={Style.emptyState}>
              {currentGroup ? '当前图片组暂无图片，请导入图片。' : '先创建或选择图片组，再导入文章配图。'}
            </div>
          ) : (
            <div className={Style.imageGrid}>
              {visibleImages.map((image) => {
                const imageLeadName = getImageLeadName(image);
                return (
                  <Card key={image.id} bordered={false} className={Style.imageCard}>
                    <div className={Style.imagePreviewWrap}>
                      <img className={Style.imagePreview} src={image.url} alt={image.alt || image.name} />
                    </div>
                    <Space direction='vertical' size={6} style={{ width: '100%' }}>
                      <div className={Style.itemTitle}>{image.name}</div>
                      <Space size={6} breakLine>
                        <Tag theme='primary' variant='light'>
                          图片组：{image.group_name}
                        </Tag>
                        <Tag variant='light'>客户资产：{imageLeadName}</Tag>
                        {image.is_local_only ? (
                          <Tag theme='warning' variant='light'>
                            本机保存
                          </Tag>
                        ) : null}
                      </Space>
                      <div className={Style.subtleText}>Alt：{image.alt || '暂无 Alt 文案'}</div>
                      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                        <Tag variant='light'>{new Date(image.created_at).toLocaleDateString('zh-CN')}</Tag>
                        <Popconfirm content='确认删除这张图片？' onConfirm={() => deleteImage(image.id)}>
                          <Button size='small' variant='text' theme='danger' icon={<DeleteIcon />}>
                            删除图片
                          </Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <Dialog
        visible={groupOpen}
        header={editingGroupId ? '编辑图片组' : '创建图片组'}
        onClose={() => setGroupOpen(false)}
        onConfirm={saveGroup}
        confirmBtn={editingGroupId ? '保存' : '创建'}
      >
        <Form layout='vertical'>
          <FormItem label='绑定客户资产'>
            <Select
              value={selectedAssetId}
              options={leadOptions}
              filterable
              clearable
              loading={leadLoading}
              placeholder='请选择客户资产，系统会按客户资产隔离图片素材组'
              onChange={selectAssetForGroup}
            />
          </FormItem>
          <FormItem label='组名称'>
            <Input
              prefixIcon={<ImageIcon />}
              value={groupName}
              placeholder='例如：青创智园官网配图 / 产品图 / 案例图'
              onChange={(value) => setGroupName(String(value))}
            />
          </FormItem>
          <FormItem label='组说明'>
            <Textarea
              value={groupDescription}
              placeholder='例如：官网首屏图、产品能力图、客户案例图、文章配图风格说明'
              autosize={{ minRows: 3, maxRows: 5 }}
              onChange={(value) => setGroupDescription(String(value))}
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

export default Images;
