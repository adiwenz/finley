import type { ModelAssumption } from "@finley/engine";

/**
 * The one place the plan explains its own tax model, in two registers.
 *
 * "How we calculate your taxes" says what the model DOES, in language that assumes no tax
 * knowledge: the short version is always visible, and a `Detailed` disclosure holds the mechanics
 * for a reader who wants them. "Simplifications and assumptions" — the jurisdiction's and the
 * engine's own disclosures — says where the model deliberately DIFFERS from a real tax situation.
 * Two questions, two sections, one panel, and nothing said twice: mechanics live here, caveats
 * live in the assumption that embodies them.
 *
 * The assumptions are rendered, never authored. Every one is declared next to the code it
 * describes ({@link import("@finley/engine").MODEL_ASSUMPTIONS} and the jurisdiction's own), so
 * changing a rule changes its disclosure and this component learns about it for free. Only the
 * durable conceptual prose — what withholding IS, what April settles — is written here, and it is
 * deliberately free of form numbers and statutory dollar figures for the same reason: those belong
 * to the rules layer, which indexes them by year.
 *
 * Both disclosures are `<details>`, so open/closed state, keyboard behaviour and hiding the
 * contents from find-in-page and the accessibility tree all come from the element.
 */
export function TaxExplainer({ assumptions }: { assumptions: readonly ModelAssumption[] }) {
  return (
    <section className="tax-explainer" aria-labelledby="tax-explainer-heading">
      <h2 id="tax-explainer-heading">How we calculate your taxes</h2>

      <p>
        Finley keeps two things apart: the tax you owe for a year, and the tax taken out of your
        money during it.
      </p>
      <p>
        For paychecks, we work out what an employer would actually take out of that paycheck. If
        you hold more than one job at once, we assume you adjust your withholding so that your jobs
        together come reasonably close to covering your tax bill.
      </p>
      <p>
        Bonuses have their own withholding rules, so a one-off bonus never makes Finley treat your
        normal salary as permanently higher.
      </p>
      <p>
        Other taxable income — investment gains, or money taken out of a retirement account — still
        counts towards your tax bill, but we generally do not pretend it was taken out of an
        earlier paycheck.
      </p>
      <p>
        At the end of each year, Finley works out the tax you actually owe on everything that
        happened that year. Withhold too much and the difference comes back as a refund the
        following April; withhold too little and it is a payment you make instead.
      </p>
      <p>
        Social Security and Medicare work the same way, taken out by each employer separately —
        including the adjustments that can happen when you file after working more than one job.
      </p>

      <details className="tax-explainer-detail">
        <summary>Detailed</summary>

        <h3>Paycheck withholding</h3>
        <p>
          For regular wages, Finley works out federal income-tax withholding from that month&rsquo;s
          paycheck, following the same method a payroll system uses. Because the plan runs a month
          at a time rather than on real paycheck dates, one month is treated as one pay period.
        </p>
        <p>
          A raise, a pay cut, a month you were not paid, a job starting or a job ending changes
          what is withheld from that month onwards. None of them ever rewrites a paycheck you have
          already been paid.
        </p>

        <h3>Multiple jobs</h3>
        <p>
          An employer normally sees only the wages it pays you. Each one therefore withholds as
          though its wages were your only income, and between them several jobs can come up short
          — each of them working from the bottom of the tax bands a second time.
        </p>
        <p>
          Finley assumes you make the withholding adjustment the W-4 asks you to make when you hold
          more than one job. The extra amount is worked out looking forward — from the wages you
          have already been paid, what your jobs pay you right now, and how many pay periods are
          left in the year — and it is carried on a single job, preferably your highest-paying
          current one. If a job starts, ends or changes pay, the adjustment changes from that point
          on.
        </p>
        <p>
          This is an assumption about what YOU put on your W-4. It is not employers quietly sharing
          payroll information with one another, which does not happen.
        </p>

        <h3>Bonuses</h3>
        <p>
          A bonus is treated as supplemental pay: withheld separately from your salary, at the flat
          rate employers commonly use for one-off payments rather than at your own tax rate.
        </p>
        <p>
          A bonus adds to the year&rsquo;s taxable income, but it never makes later ordinary
          paychecks look as though your salary had permanently gone up. Wherever the flat rate
          took too much or too little, the difference is settled when the year&rsquo;s tax is
          worked out.
        </p>

        <h3>Income outside payroll</h3>
        <p>
          Money taken out of a retirement account, required minimum distributions, taxable
          investment gains and interest all count towards what you owe for the year. In Finley they
          do not have tax withheld, and they never reach back and change a paycheck that came
          earlier.
        </p>
        <p>
          That is a modelling choice rather than a rule of tax law — in reality some of these can
          have tax withheld, and someone expecting a large bill may pay it during the year instead.
          Finley does not model those, so the whole difference lands in the following April.
        </p>

        <h3>The tax you owe for the year</h3>
        <p>
          At the end of each calendar year, Finley works out your actual federal income tax from
          the income that actually happened. That figure is the authoritative one. Everything
          withheld from a paycheck is only money paid towards it along the way.
        </p>

        <h3>The April settlement</h3>
        <p>
          The difference between the two becomes the following April&rsquo;s settlement: too little
          withheld and you make a payment, too much and you receive a refund.
        </p>
        <p>
          That April amount is real money moving in the plan — it can add to your savings or have
          to be found from them. It does not go back and change any earlier month; the paychecks
          stand as they were paid, and April squares up.
        </p>

        <h3>Social Security and Medicare</h3>
        <p>
          These are worked out per employer, because each employer applies the rules to the wages
          it alone paid.
        </p>
        <ul>
          <li>
            Social Security stops once that employer has paid you up to the annual wage cap, and
            nothing more is taken for the rest of the year.
          </li>
          <li>Medicare has no cap, so it carries on above that point.</li>
          <li>
            The extra Medicare charge on high earners starts once one employer&rsquo;s wages cross
            the level at which it is required to withhold it.
          </li>
          <li>
            With more than one employer, each applies the wage cap to its own wages — so you can
            have more Social Security taken out than you actually owe.
          </li>
          <li>
            You can also owe the extra Medicare charge when no single employer withheld any,
            because it is your combined wages that crossed the line.
          </li>
        </ul>
        <p>
          Both of those are put right when you file, and Finley settles them the following April
          along with everything else.
        </p>
      </details>

      {assumptions.length > 0 && (
        <>
          <h2>Simplifications and assumptions</h2>
          <details className="assumptions">
            <summary>Where the plan differs from real life</summary>
            <ul>
              {assumptions.map((a) => (
                <li key={a.id}>{a.text}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
