"use client";

import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";

const circles = [
  { title: "After dark", note: "photos, fits, tiny victories", tone: "violet" },
  { title: "Made by hand", note: "objects with a second life", tone: "lime" },
  { title: "Soundcheck", note: "songs before they become songs", tone: "coral" }
];

export function LandingShell() {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.6, ease: "easeOut" as const };

  return (
    <LazyMotion features={domAnimation}>
      <main className="landing-shell">
        <nav aria-label="Main navigation" className="nav">
          <a className="brand" href="/" aria-label="Kukugram home">
            <span className="brand-mark">k</span> kukugram
          </a>
          <a className="join-link" href="#join">
            Get early access <span aria-hidden="true">-&gt;</span>
          </a>
        </nav>

        <section className="hero" aria-labelledby="hero-title">
          <m.p
            className="eyebrow"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition}
          >
            The social space with a pulse
          </m.p>
          <m.h1
            id="hero-title"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.08 }}
          >
            Find the people who <em>get it.</em>
          </m.h1>
          <m.p
            className="hero-copy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.18 }}
          >
            Kukugram is a calmer kind of social. Build your feed around the circles, creators, and
            curiosity that move you.
          </m.p>
          <m.a
            id="join"
            className="primary-action"
            href="mailto:hello@kukugram.com?subject=Early%20access"
            {...(reduceMotion ? {} : { whileHover: { scale: 1.03 } })}
            whileTap={{ scale: 0.98 }}
          >
            Claim your corner <span aria-hidden="true">*</span>
          </m.a>
        </section>

        <section className="circle-section" aria-labelledby="circle-title">
          <div className="section-heading">
            <p className="eyebrow">Kuku Circles</p>
            <h2 id="circle-title">Your feed, on purpose.</h2>
          </div>
          <div className="circle-grid">
            {circles.map((circle, index) => (
              <m.article
                className={`circle-card ${circle.tone}`}
                key={circle.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ ...transition, delay: reduceMotion ? 0 : index * 0.08 }}
              >
                <span className="card-index">0{index + 1}</span>
                <div>
                  <h3>{circle.title}</h3>
                  <p>{circle.note}</p>
                </div>
                <span className="card-arrow" aria-hidden="true">
                  &nearr;
                </span>
              </m.article>
            ))}
          </div>
        </section>

        <footer>
          <span>Built for real connection.</span>
          <span>Private beta soon</span>
        </footer>
      </main>
    </LazyMotion>
  );
}
