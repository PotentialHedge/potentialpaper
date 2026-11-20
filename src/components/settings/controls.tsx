'use client';

import {
  CheckboxGroup,
  CommitNumberField,
  CommitTextField,
  EditableList,
  RadioGroup,
  RankedOptions,
  Select,
  Switch,
} from '@/components/controls';
import { ui } from '@/components/ui';
import type { Control } from '@/lib/settings/form';

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/**
 * One setting's control (`lib/settings/form.ts` `Control`), drawn with the site's standard controls
 * (`components/controls`). `value` is the setting's own; a control that edits a second setting too (a `rank` with a
 * `toggleKey`) reads it from `values` and reports it through `onChangeKey`. Saving is the row's.
 */
export function SettingControl({
  control,
  value,
  onChange,
  values,
  onChangeKey,
  label,
  disabled,
}: {
  control: Control;
  value: unknown;
  onChange: (value: unknown) => void;
  values?: Record<string, unknown>;
  onChangeKey?: (key: string, value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  switch (control.kind) {
    case 'switch':
      return <Switch checked={value === true} onCheckedChange={onChange} aria-label={label} disabled={disabled} />;
    case 'select':
      return control.display === 'radio' ? (
        <RadioGroup
          options={control.choices}
          value={typeof value === 'string' ? value : null}
          onValueChange={onChange}
          label={label}
          disabled={disabled}
        />
      ) : (
        <Select
          options={control.choices}
          value={typeof value === 'string' ? value : ''}
          onValueChange={onChange}
          label={label}
          disabled={disabled}
        />
      );
    case 'text':
      return (
        <CommitTextField
          value={typeof value === 'string' ? value : ''}
          onCommit={onChange}
          label={label}
          multiline={control.multiline}
          maxLength={control.maxLength}
          placeholder={control.placeholder}
          disabled={disabled}
        />
      );
    case 'number':
      return (
        <CommitNumberField
          value={typeof value === 'number' ? value : null}
          onCommit={onChange}
          label={label}
          minimum={control.minimum}
          maximum={control.maximum}
          nullable={control.nullable}
          disabled={disabled}
        />
      );
    case 'list':
      return (
        <EditableList
          value={asList(value)}
          onChange={onChange}
          label={label}
          options={control.choices}
          maxItems={control.maxItems}
          maxLength={control.maxLength}
          placeholder={control.placeholder}
          disabled={disabled}
        />
      );
    case 'checklist':
      return (
        <CheckboxGroup
          options={control.choices}
          value={asList(value)}
          onChange={onChange}
          inverted={control.inverted}
          disabled={disabled}
        />
      );
    case 'rank':
      return (
        <RankedOptions
          options={control.choices}
          value={asList(value)}
          onChange={onChange}
          hidden={control.toggleKey ? asList(values?.[control.toggleKey]) : undefined}
          placement={control.placeKey ? asRecord(values?.[control.placeKey]) : undefined}
          onPlacementChange={
            control.placeKey && onChangeKey ? (placement) => onChangeKey(control.placeKey!, placement) : undefined
          }
          onHiddenChange={
            control.toggleKey && onChangeKey ? (hidden) => onChangeKey(control.toggleKey!, hidden) : undefined
          }
          label={label}
          disabled={disabled}
        />
      );
    case 'file':
      return (
        <p className={`${ui.fine} mt-0`}>Set this one in your settings.json: download it, edit it and upload it.</p>
      );
  }
}
