import Link from 'next/link';
import { LegalPage, type LegalSection } from '@/components/legal/LegalPage';
import { pageMetadata } from '@/lib/site';

export const metadata = pageMetadata({
  title: 'Privacy policy',
  description: 'What Bullseye stores about you, why, who processes it, how long it is kept and how to delete it.',
  path: '/privacy',
});

const sections: LegalSection[] = [
  {
    id: 'who',
    title: 'Who runs Bullseye',
    body: (
      <p>
        Bullseye is an independent project built and run by one person in India. It is not a registered company. In this
        policy, &ldquo;we&rdquo; means the person who runs Bullseye, and &ldquo;you&rdquo; means anyone who uses the site.
      </p>
    ),
  },
  {
    id: 'collect',
    title: 'What we collect',
    body: (
      <>
        <p>You can use the screener, stock pages and Ask AI without an account. We only store what is listed here.</p>
        <ul>
          <li>
            <strong>Your account.</strong> If you sign up, your email address. If you use Google sign-in, also the name and
            profile picture Google shares. Passwords are handled by our sign-in provider, Supabase, and are never visible
            to us.
          </li>
          <li>
            <strong>What you save.</strong> Price alerts, saved strategies, your daily email settings, and a record of which
            alert emails were sent to you.
          </li>
          <li>
            <strong>Ask AI conversations.</strong> When you are signed in, your questions and the answers are saved so you
            can reopen them. They are deleted automatically after 48 hours.
          </li>
          <li>
            <strong>Questions you type.</strong> To write an answer, the text of your question and the market data it needs
            are sent to an AI model provider (see section 5). Please do not type personal details into questions.
          </li>
          <li>
            <strong>Technical data.</strong> Your IP address is used briefly to limit how many requests one visitor can
            send. Our hosting providers keep standard server logs for a short time.
          </li>
          <li>
            <strong>Visit counts.</strong> We use Vercel Web Analytics to count page views and see which pages are used.
            It does not use cookies and does not identify you.
          </li>
          <li>
            <strong>Campaign tags.</strong> If you arrive through a link with tags such as <code>utm_source</code>, we keep
            those tags in your browser and save them with your account if you sign up, so we know which links bring people
            here. The tags describe the link, not you.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'storage',
    title: 'Cookies and browser storage',
    body: (
      <>
        <p>
          Bullseye does not use advertising or cross-site tracking cookies. It keeps a few small items in your
          browser&apos;s local storage so the site works:
        </p>
        <ul>
          <li>your sign-in session, if you are signed in</li>
          <li>your light or dark theme choice</li>
          <li>recently loaded market data, so pages open faster</li>
          <li>whether you have closed the storage notice or the sign-in prompt</li>
          <li>campaign tags from the link you arrived through, if any</li>
        </ul>
        <p>You can clear these at any time from your browser settings. Clearing them signs you out.</p>
      </>
    ),
  },
  {
    id: 'use',
    title: 'How we use it',
    body: (
      <ul>
        <li>to sign you in and keep your alerts, strategies and settings</li>
        <li>to send the emails you turned on, such as alert emails and the daily short list</li>
        <li>to answer your questions in Ask AI and the AI search bars</li>
        <li>to keep the service running, stop abuse and fix problems</li>
        <li>to understand which pages are used, in counts only</li>
      </ul>
    ),
  },
  {
    id: 'processors',
    title: 'Services that process your data',
    body: (
      <>
        <p>Bullseye is built on these providers. Each one only receives what it needs for its job.</p>
        <ul>
          <li>
            <strong>Supabase</strong>: sign-in and the database that stores your account and saved items
          </li>
          <li>
            <strong>Vercel</strong>: hosts the website and provides the page view counts
          </li>
          <li>
            <strong>Render</strong>: runs the server that fetches market data and answers questions
          </li>
          <li>
            <strong>Groq</strong> and <strong>Google (Gemini)</strong>: AI models that write answers to your questions
          </li>
          <li>
            <strong>Resend</strong>: delivers the emails you turned on
          </li>
          <li>
            <strong>Google</strong>: sign-in, only if you choose &ldquo;Continue with Google&rdquo;
          </li>
        </ul>
        <p>
          Some of these providers store or process data outside India. We do not sell your data, and we do not share it
          with anyone for advertising.
        </p>
      </>
    ),
  },
  {
    id: 'retention',
    title: 'How long we keep it',
    body: (
      <ul>
        <li>Ask AI conversations: 48 hours</li>
        <li>Your account, alerts, strategies, email settings and email records: until you delete your account</li>
        <li>Server logs and rate-limit data: a short time, as set by our hosting providers</li>
      </ul>
    ),
  },
  {
    id: 'rights',
    title: 'Your choices and rights',
    body: (
      <>
        <p>
          Under India&apos;s Digital Personal Data Protection Act, 2023 you can ask to see, correct or erase your personal
          data, and you can withdraw consent at any time. On Bullseye you can do this yourself:
        </p>
        <ul>
          <li>see and change your alerts and email settings from your account menu</li>
          <li>stop emails with the unsubscribe link in any email, or turn them off in Daily alerts</li>
          <li>
            delete your account from the account menu with <strong>Delete account and data</strong>. This removes your
            account, alerts, strategies, Ask AI history, email settings and email records straight away.
          </li>
        </ul>
        <p>Copies held in our providers&apos; backups are removed when those backups expire.</p>
      </>
    ),
  },
  {
    id: 'security',
    title: 'Security',
    body: (
      <p>
        The site is served only over HTTPS. Secret keys stay on the server and are never sent to your browser. Each signed-in
        request is checked against your session, and the database only returns rows that belong to you. No system is
        perfectly secure, so please use a strong password that you do not use anywhere else.
      </p>
    ),
  },
  {
    id: 'age',
    title: 'Age',
    body: <p>Bullseye is meant for people aged 18 or over. Please do not create an account if you are younger.</p>,
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        If we change what we collect or how we use it, we will update this page and the date at the top. If you keep using
        Bullseye after a change, the new policy applies. You can also read our <Link href="/terms">terms of use</Link>.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy policy"
      sibling={{ href: '/terms', label: 'Read the terms of use' }}
      sections={sections}
      summary={
        <p>
          <span className="font-medium text-white">In short:</span> you can use Bullseye without an account. If you sign up
          we store your email and the alerts and settings you save, and nothing is sold or used for ads. Questions you ask
          are sent to an AI provider to write the answer. You can delete your account and everything saved with it from the
          account menu at any time.
        </p>
      }
    />
  );
}
