/** Small labelled number field with optional $ / % / unit affixes. */

export function NumInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
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
          max={max}
          step={step ?? 1}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (!Number.isNaN(raw)) onChange(raw);
          }}
          onBlur={() => {
            // The min/max attributes bound only the spinner arrows, and typing flows
            // through freely above so intermediate digits aren't fought. Clamp to any
            // explicit bound on commit; unbounded fields are unaffected.
            let next = value;
            if (min !== undefined) next = Math.max(min, next);
            if (max !== undefined) next = Math.min(max, next);
            if (next !== value) onChange(next);
          }}
        />
        {suffix && <span className="field-affix">{suffix}</span>}
      </span>
    </label>
  );
}
