'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@hivemind/shared';
import { botsApi, type ProjectWithMembers } from '@/lib/api';
import { Field, FormModal, Input, Select } from '@/components/ui';
import { buildBotCreate, emptyBotFormState } from '@/lib/bot-form';
import { AvatarPicker } from './AvatarPicker';

/**
 * 轻量新建弹窗：只收 名字 / 头像 / 岗位 / 项目 / Provider / Token，
 * 其余配置（工具/技能/调度/高级）在创建后进入 bot 详情页完成。创建后跳转到该 bot 页面。
 */
export function NewBotModal({
  open,
  onClose,
  providers,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  providers: Provider[];
  projects: ProjectWithMembers[];
}) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [role, setRole] = useState('');
  const [projectId, setProjectId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 打开时重置；provider 默认取第一个
  useEffect(() => {
    if (!open) return;
    setName('');
    setAvatar('');
    setRole('');
    setProjectId('');
    setProviderId(providers[0]?.id ?? '');
    setToken('');
    setErr(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const input = buildBotCreate({
        ...emptyBotFormState(providerId || providers[0]?.id),
        name,
        avatar,
        role,
        projectId,
        providerId: providerId || providers[0]?.id || '',
        discordToken: token,
      });
      const created = await botsApi.create(input);
      router.push(`/bots/${created.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title="新建 Bot"
      size="md"
      submitText="创建并配置"
      onSubmit={onSubmit}
      submitting={submitting}
      error={err}
      initialFocusRef={nameRef}
    >
      <div className="space-y-3">
        <Field label="头像（点击 / 拖入图片上传；不设则用名字首字自动生成）">
          <AvatarPicker value={avatar} onChange={setAvatar} name={name} />
        </Field>
        <Field label="Bot 名称（日志/列表显示，非 Discord 显示名）">
          <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="PM-Alice" required />
        </Field>
        <Field label="岗位 / 工种（如 程序 / 策划 / 项目经理；可留空，之后再改）">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如：程序" />
        </Field>
        <Field label="所属项目（同项目的 bot 可互相 @ 协作；可留空）">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">（不加入任何项目）</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Provider（决定用哪个 API endpoint + 模型）">
          <Select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} → {p.model}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Discord Bot Token（存入 Windows Credential Manager）">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="font-mono"
            required
          />
        </Field>
      </div>
    </FormModal>
  );
}
