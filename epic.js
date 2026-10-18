// Prefill the PE Workup from the Epic chart when the page was opened via tools.clinicallinks.net/launch/.
// Fills age, heart rate, SpO2, prior VTE, malignancy, estrogen use and D-dimer (FEU);
// clinical findings (DVT signs, "PE most likely", hemoptysis, surgery/immobilization) stay with the clinician.
(async () => {
  const s = typeof SMART !== "undefined" && SMART.session();
  if (!s || !s.patient) return;
  const box = document.getElementById("epic");
  box.style.display = "block";
  box.innerHTML = '<div class="card-hd">Epic</div><p>Loading chart data…</p>';

  const LOINC = { hr: "8867-4", spo2: ["59408-5", "2708-6"], ddFeu: "48065-7", ddDdu: "48066-5" };
  const VITALS_H = 24, LAB_H = 24;

  // Active problem-list matches: ICD-10-CM prefixes and SNOMED CT codes.
  const PROBLEMS = {
    vte:    { label: "Prior DVT/PE", icd: ["I26", "I82.4", "I82.5", "I82.6", "I82.9", "Z86.711", "Z86.718"], snomed: ["59282003", "128053003", "429098002"] },
    cancer: { label: "Malignancy", icd: ["C0", "C1", "C2", "C3", "C40", "C41", "C43", "C45", "C46", "C47", "C48", "C49", "C5", "C6", "C7", "C8", "C90", "C91", "C92", "C93", "C94", "C95", "C96"], snomed: ["363346000"] },
  };
  const ESTROGEN = /estradiol|estrogen|ethinyl|estrone|estropipate|premarin|conjugated/i;

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmtTime = d => d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const when = o => new Date(o.effectiveDateTime || o.effectivePeriod?.start || o.issued || 0);
  const codes = o => (o.code?.coding || []).map(c => c.code);
  const latest = (list, code, hours) => {
    const want = [].concat(code), since = Date.now() - hours * 3600e3;
    const hits = list.filter(o => !["entered-in-error", "cancelled"].includes(o.status) && codes(o).some(c => want.includes(c)) && o.valueQuantity?.value != null)
      .sort((a, b) => when(b) - when(a));
    return { recent: hits.find(o => when(o) >= since), any: hits[0] };
  };
  const setWells = (id, on) => { if (wellsState[id] !== on) toggleWells(id); };
  const setPerc = (id, on) => { if (percState[id] !== on) togglePerc(id); };

  const notes = [], filled = [];
  const denied = what => e => { notes.push(`${what} not available (${e.message})${/: 403\b/.test(e.message) ? ": Epic refused access" : ""}`); return null; };
  try {
    const p = s.patient;
    const [pt, vitals, labs, conds, meds] = await Promise.all([
      SMART.get(`Patient/${p}`).catch(denied("Demographics")),
      SMART.search(`Observation?patient=${p}&category=vital-signs&code=http://loinc.org|${LOINC.hr},http://loinc.org|${LOINC.spo2.join(",http://loinc.org|")}&_count=100`).catch(denied("Vital signs")),
      SMART.search(`Observation?patient=${p}&code=http://loinc.org|${LOINC.ddFeu},http://loinc.org|${LOINC.ddDdu}&_count=50`).catch(denied("Labs")),
      SMART.search(`Condition?patient=${p}&category=problem-list-item&_count=100`).catch(denied("Problem list")),
      SMART.search(`MedicationRequest?patient=${p}&status=active&_count=100`).catch(denied("Medications")),
    ]);

    // Age (PERC ≥ 50)
    const name = pt?.name?.[0] ? [pt.name[0].given?.join(" "), pt.name[0].family].filter(Boolean).join(" ") : "patient (name unavailable)";
    if (pt?.birthDate) {
      const b = new Date(pt.birthDate), now = new Date();
      const age = now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
      setPerc("p1", age >= 50); filled.push(`age ${age}`);
    }

    // Vitals: most recent in the last 24 h
    if (vitals) {
      const hr = latest(vitals, LOINC.hr, VITALS_H), sat = latest(vitals, LOINC.spo2, VITALS_H);
      if (hr.recent) {
        const v = hr.recent.valueQuantity.value;
        setWells("w3", v > 100); setPerc("p2", v >= 100);
        filled.push(`HR ${v} (${fmtTime(when(hr.recent))})`);
      } else notes.push(hr.any ? `Last heart rate is older than ${VITALS_H} h: not used` : "No heart rate found");
      if (sat.recent) {
        const v = sat.recent.valueQuantity.value;
        setPerc("p3", v < 95);
        filled.push(`SpO₂ ${v}% (${fmtTime(when(sat.recent))})`);
        if (v < 95) notes.push("PERC uses SpO₂ on room air: confirm the patient was not on oxygen");
      } else notes.push(sat.any ? `Last SpO₂ is older than ${VITALS_H} h: not used` : "No SpO₂ found");
    }

    // D-dimer: FEU goes in (ng/mL); DDU is shown but not converted
    if (labs) {
      const feu = latest(labs, LOINC.ddFeu, LAB_H), ddu = latest(labs, LOINC.ddDdu, LAB_H);
      if (feu.recent) {
        const q = feu.recent.valueQuantity, unit = (q.unit || q.code || "").toLowerCase().replace(/\s/g, "");
        const perMl = ["mg/l", "ug/ml", "µg/ml", "mcg/ml"].includes(unit) ? q.value * 1000 : q.value;
        document.getElementById("dd-val").value = Math.round(perMl);
        setUnit("ngmL");
        filled.push(`D-dimer ${q.comparator || ""}${Math.round(perMl)} ng/mL FEU (${fmtTime(when(feu.recent))})`);
      } else if (ddu.recent) {
        const q = ddu.recent.valueQuantity;
        notes.push(`D-dimer ${q.value} ${q.unit || ""} is in DDU; the Kohn intervals use FEU (about 2 × DDU), so it was not entered`);
      } else notes.push((feu.any || ddu.any) ? `Last D-dimer is older than ${LAB_H} h: not used` : "No D-dimer found (LOINC 48065-7 / 48066-5)");
    }

    // Problem list: prior VTE (Wells + PERC), malignancy (Wells)
    if (conds) {
      const hits = {};
      const active = conds.filter(c => !c.clinicalStatus || (c.clinicalStatus.coding || []).some(x => x.code === "active"));
      for (const c of active) for (const cd of c.code?.coding || []) {
        const sys = cd.system || "", code = (cd.code || "").toUpperCase();
        for (const [k, r] of Object.entries(PROBLEMS)) {
          const match = sys.includes("icd-10") ? r.icd.some(x => code.startsWith(x)) : sys.includes("snomed") && r.snomed.includes(code);
          if (match) (hits[k] ||= new Set()).add(c.code.text || cd.display || code);
        }
      }
      if (hits.vte) { setWells("w5", true); setPerc("p7", true); filled.push(`prior VTE (${[...hits.vte].join("; ")})`); }
      if (hits.cancer) { setWells("w7", true); filled.push(`malignancy (${[...hits.cancer].join("; ")})`); notes.push("Wells counts malignancy only if on treatment, treated in the last 6 months, or palliative: confirm"); }
      if (!hits.vte && !hits.cancer) notes.push("No prior VTE or malignancy on the active problem list");
    }

    // Estrogen use (PERC)
    if (meds) {
      const names = meds.map(m => m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || m.medicationReference?.display || "")
        .filter(n => ESTROGEN.test(n));
      if (names.length) { setPerc("p8", true); filled.push(`estrogen (${[...new Set(names)].join("; ")})`); }
      else notes.push("No active estrogen-containing medication found");
    }

    // PERC's verdict is computed on toggle; recompute once now that Wells (pre-test probability) is also set.
    if (Object.values(percState).some(Boolean)) updatePerc();

    box.innerHTML = `<div class="card-hd">Prefilled from Epic</div>
      <p><strong>${esc(name)}${pt?.birthDate ? ", DOB " + esc(pt.birthDate) : ""}</strong></p>
      <p>${filled.map(esc).join(" · ") || "Nothing found to prefill."}</p>
      ${notes.length ? `<ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${notes.some(n => n.includes(": 403")) ? `<p class="epic-hint">Permissions granted by Epic: ${esc(s.scope || "(none listed)")}</p>` : ""}
      <p class="epic-hint">Check every item. DVT signs, "PE most likely", hemoptysis, leg swelling, and recent surgery or immobilization are not taken from the chart. <a href="../fhir/#trace" style="color:var(--gold)">How this launch worked</a></p>`;
  } catch (e) {
    box.innerHTML = `<div class="card-hd">Epic</div><p>Could not load chart data: ${esc(e.message)}. Enter values by hand.</p>`;
  }
})();
