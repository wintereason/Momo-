import type { PageProps } from "../SettingsApp";
import { DeleteData } from "../../components/DeleteData";

export function PrivacyPage(_props: PageProps) {
  return (
    <>
      <h1>Privacy &amp; data</h1>
      <p className="lead">What Momo keeps, what it sends, and what it may do without asking.</p>

      <fieldset>
        <legend>What Momo keeps</legend>
        <ul className="plain">
          <li>Your <strong>audio</strong> is never saved. By default it is turned into text on this PC and discarded. Only if you choose <em>Cloud speech</em> (Language &amp; voice) is each sentence's audio sent to Groq over HTTPS to be transcribed; Momo still keeps nothing.</li>
          <li>What you dictated is <strong>not stored</strong>. There is no history.</li>
          <li>Only your settings are saved on this PC, plus a small counter of today's AI requests.</li>
          <li>Momo does not type into password boxes it can recognise (ordinary Windows apps). A password box <strong>inside a web page</strong> is not always visible to Windows, so don't dictate passwords or other secrets.</li>
          <li>When the AI is on, the <strong>words you dictated</strong> (not audio) go to your chosen free AI service for correction. That service has its own retention policy. Ollama keeps it all on this PC.</li>
        </ul>
      </fieldset>

      <fieldset>
        <legend>When Momo asks you first</legend>
        <p className="hint"><strong>Never for routine things:</strong> opening a file, folder, app or website, switching windows, or reading a window on this PC. If there is one clear match, Momo does it, says what it opened, and checks that it really opened. If several things match, it shows you all of them (names and full paths) and you pick one by click or by voice.</p>
        <p className="hint"><strong>Always for decisions:</strong> closing a window, running a program, clicking buttons like Send, Delete, Save, Pay, OK or Submit, picking an account from a guess, and sending what is on your screen to an online AI. Momo has no way to send, delete or buy anything. It never types into password boxes it can recognise and never reads them.</p>
      </fieldset>

      <fieldset>
        <legend>Delete my data</legend>
        <DeleteData />
        <p className="hint">This does not control a third-party AI service's own retention policy.</p>
      </fieldset>
    </>
  );
}
