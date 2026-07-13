/** Small labelled number field with optional $ / % / unit affixes. */

export function NumInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input-wrap">
        {prefix && <span className="field-affix">{prefix}</span>}
        <input
          type="number"
          value={value}
          min={min ?? 0}
          step={step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && <span className="field-affix">{suffix}</span>}
      </span>
    </label>
  );
}
