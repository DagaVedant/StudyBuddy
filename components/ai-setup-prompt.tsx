import Link from 'next/link'

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
