# Open Time Board — three lists

> **Status:** Change spec · amends `OpenTimeFulfillment.md` / `OROpenTime.md` F4
> **Owner:** Kartheek (product) · 2026-08-28
> **Scope:** the Open Time Board tab of Release Time Mgmt. One flat slot list
> with status chips becomes three explicit lists, ordered by what needs a human.

---

## 1. The three lists

| # | List | Contains | The question it answers |
|---|---|---|---|
| **1** | **Needs an offer** *(primary)* | Released time with no live offer out | Who should I give this to? |
| **2** | **Awaiting response** | Offer sent, no reply yet | What's in flight? |
| **3** | **Booked** | Someone took it | What did we recover? |

Order is deliberate: **action → in flight → done.** List 1 gets visual primacy —
larger heading, first, and it is the list the candidate-ranking panel serves.

This is also the fill-rate funnel from `OpenTimeFulfillment.md` §2 made
actionable: the summary strip states *released → offered → booked* as figures;
these are the same three states as work. Header counts on each list should
reconcile with the strip exactly.

---

## 2. Membership — and one gap it exposes

```
List 1  status = OPEN
        OR status = OFFERED with no offer still in SENT
List 2  status = OFFERED with ≥ 1 offer in SENT
List 3  status = BOOKED
```

**The gap:** today, when an offer is `PASSED` or `LAPSED`, the slot's own status
stays `OFFERED`. A slot whose every offer has been declined or has expired
therefore sits permanently in "awaiting response" — awaiting nothing. Nobody is
going to reply, and the released hours quietly stop being worked.

Rather than patch it in the view, fix it where it happens: **when the last live
offer on a slot resolves to `PASSED` or `LAPSED`, return the slot to `OPEN`.**
The membership rule above then falls out naturally, and the store stops holding
a state that cannot progress.

Such a slot appears in list 1 with its history stated — *"Offered to Dr. Reyes ·
declined 3 days ago"* — so the scheduler knows this is a second attempt and who
already said no. That context is the difference between a useful queue and a
list that keeps handing back the same dead end.

---

## 3. What each row shows

**List 1 — Needs an offer**
`Date · Site · Block · Service · Hours` and, when there is one, the prior-offer
line. Selecting a row loads the ranked candidate list into the panel, exactly as
today. This is the only list with the offer action.

**List 2 — Awaiting response**
`Date · Site · Block · Hours` plus **who was offered and when** — the whole
point of the list is knowing what is outstanding and with whom. Where multiple
candidates were offered simultaneously, show the count and name the first.
Selecting a row shows the offer detail rather than the candidate ranking; there
is nothing to rank while an offer is live.

**List 3 — Booked**
`Date · Site · Block · Hours` plus **who booked it and when**. Sorted most
recent first. This is the win list — show the hours recovered plainly, since it
is the number the whole capability exists to produce.

Each list header carries a **count and total hours** (`4 slots · 22.5h`).
Empty states are real states, phrased as such: *"Nothing awaiting response."*

---

## 4. Rules

- No status chips inside the lists. The list a row sits in *is* its status;
  a chip repeating it is redundant, and the current chip colours are doing work
  the headings should do.
- Selecting a row in any list keeps the panel in context — candidate ranking for
  list 1, offer detail for list 2, booking detail for list 3.
- Booking a slot moves it from list 2 to list 3 in place, without a page
  refresh, and updates both header counts.
- Booking also creates the `BOOK_IN_EMR` fulfilment task
  (`OpenTimeFulfillment.md` §1) — unchanged, but verify the transition still
  fires after this refactor.

---

## 5. Acceptance

- [ ] Three lists render in the order Needs an offer / Awaiting response /
      Booked, with list 1 given visual primacy.
- [ ] A slot whose offers have all been passed or lapsed returns to `OPEN` in
      the store and appears in list 1 with its prior-offer history stated.
- [ ] No slot appears in two lists; every slot appears in exactly one.
- [ ] List counts and hours reconcile with the summary strip's funnel figures.
- [ ] List 2 rows name the offeree and the date sent; list 3 rows name who
      booked and when.
- [ ] Candidate ranking loads only for list 1 selections.
- [ ] Booking moves a row list 2 → list 3 in place and updates both counts.
- [ ] `BOOK_IN_EMR` task still created on booking.
- [ ] Demo seed populates all three lists — at least two needing an offer
      (one of them a second attempt after a decline), one awaiting, two booked.
- [ ] Empty lists show a plain sentence, not an error or a blank panel.
