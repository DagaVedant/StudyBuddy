import Link from 'next/link'

/**
 * spec.md:339's first moment: "when the trial runs low (1 worksheet left)".
 *
 * The second moment, settings, has always existed. This one did not, and its
 * absence is what made the trial end as a surprise: `worksheetsRemaining` was
 * read in exactly one place, on a screen a student has no particular reason to
 * visit. The dashboard tile does carry the count, but it is a label in a card,
 * it never changes character as the number falls, and nothing about reading
 * "1 trial worksheet left" in passing suggests that the next upload after this
 * one lands in a manual editor.
 *
 * Shown at one remaining rather than zero because zero is too late: at zero the
 * student has already met the wall, on the completion route, as a message
 * explaining they have been dropped to the manual editor.
 *
 * The three options are the spec's, in the spec's order, and the third is
 * deliberately not a link. "Stay free" is what happens if this card is ignored,
 * and dressing inaction up as a button to click would make the honest choice
 * look like the effortful one.
 */
export default function AiSetupPrompt() {
  return (
    <section
      aria-labelledby="ai-setup-prompt-heading"
      className="card my-8 p-4"
    >
      <h2 id="ai-setup-prompt-heading" className="text-sm font-medium">
        One trial worksheet left
      </h2>
      <p className="hint text-pretty">
        After that, StudyBuddy stops reading worksheets for you. Everything else
        keeps working: marking, review, explanations you have already generated,
        and your whole dashboard. Three ways forward.
      </p>

      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="font-medium">Your own API key</dt>
          <dd className="text-muted">
            Best extraction quality. You pay Anthropic or OpenAI directly, per
            worksheet, and nothing is capped.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Your own GPU</dt>
          <dd className="text-muted">
            Free and private if you already run Ollama. Reading happens in your
            browser, so the tab has to stay open while it works.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Stay free</dt>
          <dd className="text-muted">
            Do nothing. You type each worksheet&rsquo;s questions in yourself,
            and every other feature is unchanged.
          </dd>
        </div>
      </dl>

      <Link href="/settings" className="btn btn-primary mt-4 sm:w-auto sm:px-6">
        Choose how StudyBuddy thinks
      </Link>
    </section>
  )
}
