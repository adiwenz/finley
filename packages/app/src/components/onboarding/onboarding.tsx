/**
 * Onboarding: one page, five questions, then a projection.
 *
 * Deliberately a single page rather than a wizard. Five short fields do not earn three screens
 * of progress dots, and a stepper hides how little is actually being asked — the reader cannot
 * see the end from step one, so it reads as longer than it is. On one page the whole ask is
 * visible at a glance, answers can be filled in any order, and a correction to the first field
 * does not mean walking back through the others.
 *
 * Nothing here is required to be right. The copy says so, because the fastest way to a plan the
 * reader will engage with is a rough projection they immediately want to fix.
 */

import { useState } from "react";
import { Button, Input, Select } from "../ds";
import { DEFAULT_ANSWERS, type OnboardingAnswers } from "../../onboardingInput";
import moneyTree from "../../assets/money-tree.png";

export interface OnboardingProps {
  readonly onFinish: (answers: OnboardingAnswers) => void;
  readonly onCancel: () => void;
  /** Why the last submission was refused, shown against the fields that caused it. */
  readonly error?: string;
}

/** Digits only, so a reader typing "$85,000" or "85k" still lands on a number. */
function toNumber(raw: string): number {
  const parsed = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const currency = (dollars: number) => `$${dollars.toLocaleString("en-US")}`;

export function Onboarding({ onFinish, onCancel, error }: OnboardingProps) {
  const [answers, setAnswers] = useState<OnboardingAnswers>(DEFAULT_ANSWERS);
  const set = <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) =>
    setAnswers((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="absolute inset-0 z-70 overflow-y-auto bg-surface-page p-8">
      <div className="mx-auto w-full max-w-[560px] animate-fin-rise">
        {/* The one place the artwork runs large, which is how the system says to present it —
            onboarding is the first thing a reader sees, and the illustration is the brand. */}
        <img src={moneyTree} alt="" className="mb-2 block h-40 w-40 object-contain" />
        <div className="eyebrow">Build your plan</div>
        <h1 className="mt-1.5 font-display text-[32px] font-bold tracking-[-0.025em] text-leaf-900">
          Let’s see your future.
        </h1>
        <p className="mt-1.5 mb-5.5 text-[16px] leading-relaxed text-ink-600">
          Five rough answers are enough for a first projection. Nothing here has to be exact —
          you can change any of it later.
        </p>

        <div className="flex flex-col gap-4 rounded-panel border border-border-subtle bg-surface-card p-6 shadow-sm">
          <Input
            label="How old are you?"
            value={String(answers.age)}
            onChange={(e) => set("age", toNumber(e.target.value))}
          />

          <Select
            label="Are you planning with a partner?"
            options={[
              { value: "no", label: "Just me" },
              { value: "yes", label: "Me and a partner" },
            ]}
            value={answers.partnered ? "yes" : "no"}
            onChange={(e) => set("partnered", e.target.value === "yes")}
          />

          <Input
            label="Household income"
            hint="Yearly, before tax."
            value={currency(answers.annualIncomeDollars)}
            onChange={(e) => set("annualIncomeDollars", toNumber(e.target.value))}
          />

          <Input
            label="Household spending"
            hint="Per month, everything included."
            value={currency(answers.monthlySpendDollars)}
            onChange={(e) => set("monthlySpendDollars", toNumber(e.target.value))}
          />

          <Input
            label="Savings and investments"
            hint="Cash and investments together. Debt and property come later."
            value={currency(answers.savingsDollars)}
            onChange={(e) => set("savingsDollars", toNumber(e.target.value))}
          />

          {error ? (
            <p role="alert" className="text-[13.5px] leading-normal text-berry-600">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex items-center gap-2.5">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <div className="flex-1" />
          <Button
            variant="primary"
            size="md"
            iconRight="arrow-right"
            onClick={() => onFinish(answers)}
          >
            See my future
          </Button>
        </div>
      </div>
    </div>
  );
}
