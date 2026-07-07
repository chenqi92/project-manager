// @vitest-environment jsdom
// JSON 树视图冒烟测试：在 jsdom 下挂载 JsonTreeView，确保渲染、折叠、数组「提取字段」不抛错。
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { JsonTreeView, parseJson } from '@/entrypoints/options/JsonView';

const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const sample = {
  code: 0,
  data: {
    list: [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ],
    total: 2,
  },
};

function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
}

function clickByText(host: HTMLElement, text: string) {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

// 受控 input：直接赋值会被 React 的 value tracker 覆盖，需走原型 setter 再派发 input 事件。
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('parseJson', () => {
  it('接受合法 JSON、拒绝非法 JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson('nope').ok).toBe(false);
    expect(parseJson('   ').ok).toBe(false);
  });
});

describe('JsonTreeView', () => {
  it('渲染键名与标量值、工具栏按钮', () => {
    const host = mount(<JsonTreeView value={sample} onCopy={vi.fn()} defaultExpandDepth={9} />);
    const text = host.textContent ?? '';
    expect(text).toContain('code');
    expect(text).toContain('list');
    expect(text).toContain('alice');
    expect(text).toContain('展开全部');
    expect(text).toContain('折叠全部');
  });

  it('折叠全部 / 展开全部不抛错', () => {
    const host = mount(<JsonTreeView value={sample} onCopy={vi.fn()} />);
    clickByText(host, '折叠全部');
    clickByText(host, '展开全部');
    expect(host.textContent).toContain('alice');
  });

  it('复制会调用 onCopy 传入格式化 JSON', () => {
    const onCopy = vi.fn();
    const host = mount(<JsonTreeView value={sample} onCopy={onCopy} />);
    clickByText(host, '复制');
    expect(onCopy).toHaveBeenCalledWith(JSON.stringify(sample, null, 2), 'JSON');
  });

  it('数组节点可提取字段，列出每一项的值', () => {
    const onCopy = vi.fn();
    const host = mount(<JsonTreeView value={sample} onCopy={onCopy} />);
    // 打开数组的「提取字段」面板
    clickByText(host, '提取字段');
    const input = host.querySelector<HTMLInputElement>('input[placeholder^="字段名"]');
    expect(input).toBeTruthy();
    typeInto(input!, 'name');
    clickByText(host, '提取');
    const text = host.textContent ?? '';
    expect(text).toContain('命中 2 / 2 项');
    expect(text).toContain('alice');
    expect(text).toContain('bob');
    clickByText(host, '复制全部');
    expect(onCopy).toHaveBeenCalledWith(JSON.stringify(['alice', 'bob'], null, 2), '全部值');
  });
});
