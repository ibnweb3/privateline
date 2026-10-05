// The example conversations the home page replays. Plain data with no imports, so a test can check
// every reply against what the app really sends (test/home-scenes.test.ts).
//
// Step kinds, played in order:
//   { you }                      a text typed into the phone and sent
//   { pl, think }                a reply, after a typing pause of `think` ms
//   { sys }                      a divider line in the thread
//   { ops, tally, tone }         operator states ("idle" "proposed" "confirmed" "refused" "offline")
//                                and the line under them
// Any step may also have `hold`: how long to wait afterwards, in ms.

export const OPERATORS = [
  { id: "sms", name: "SMS operator", node: "node 1" },
  { id: "price", name: "Price checker", node: "node 2" },
  { id: "risk", name: "Risk checker", node: "node 3" },
];

const YES = "YES ••••";

export const SCENES = [
  {
    id: "buy",
    label: "Buy gold",
    note: "A typical approval takes about two seconds.",
    steps: [
      { you: "BUY GOLD 20" },
      { pl: "Buy $20.00 of Gold at about $4,145.59/oz (0.00482 oz)? Reply YES and your PIN within 2 min to confirm, NO to cancel. Ref TEA5E", think: 1100 },
      { you: YES },
      { sys: "The SMS operator proposes the trade on the ledger", ops: { sms: "proposed" }, tally: ["1 of 3", "waiting for a checker"], tone: "wait", hold: 900 },
      { ops: { price: "confirmed" }, tally: ["2 of 3", "approved in about 2 s"], tone: "ok", hold: 800 },
      { ops: { risk: "confirmed" }, hold: 500 },
      { pl: "Done: bought 0.00482 oz Gold for $20.00 at $4,145.59/oz. Cash $80.00. Ref TEA5E", think: 700 },
    ],
  },
  {
    id: "deposit",
    label: "Add naira",
    note: "The demo bank is simulated. On MainNet, naira arrives through a licensed partner.",
    steps: [
      { you: "DEPOSIT" },
      { pl: "To add money, send naira to PrivateLine Demo Bank, account 9912345678 (PrivateLine pl-a855), from your bank app or USSD. Rate: N1,347 = $1. We'll text you when it lands.", think: 1000 },
      { sys: "N15,000 arrives from your bank", hold: 1100 },
      { sys: "The SMS operator proposes the deposit", ops: { sms: "proposed" }, tally: ["1 of 3", "waiting for a checker"], tone: "wait", hold: 900 },
      { ops: { risk: "confirmed" }, tally: ["2 of 3", "approved in about 2 s"], tone: "ok", hold: 800 },
      { ops: { price: "confirmed" }, hold: 400 },
      { pl: "Received N15,000 = $11.13 at N1,347/$. Cash $111.13. Text BUY GOLD 10 to invest.", think: 700 },
    ],
  },
  {
    id: "refused",
    label: "Bad price",
    note: "This happened on 29 September, on live prices. No money moved.",
    steps: [
      { you: "SELL GOLD ALL" },
      { pl: "Sell all 0.00482 oz of Gold at about $4,112.56/oz (about $19.82)? Reply YES and your PIN within 2 min to confirm, NO to cancel. Ref K3M9Q", think: 1100 },
      { you: YES },
      { sys: "The SMS operator proposes the sale", ops: { sms: "proposed" }, tally: ["1 of 3", "waiting for a checker"], tone: "wait", hold: 900 },
      { sys: "Both checkers compare Canton's price with the real market: 1.69% under, limit 1.5%", ops: { price: "refused", risk: "refused" }, tally: ["Refused", "no money moved"], tone: "bad", hold: 1200 },
      { pl: "Not done: Gold costs 1.69% less on Canton than on the market right now, so our independent price checkers refused it. No money moved. Ref K3M9Q", think: 800 },
    ],
  },
  {
    id: "down1",
    label: "1 node down",
    note: "Measured on LocalNet: with one checker stopped, the trade still executed in 5.8 s.",
    start: { risk: "offline" },
    steps: [
      { sys: "The risk checker is offline", tally: ["2 operators online", "enough to approve"], tone: "wait", hold: 1000 },
      { you: "BUY SPY 15" },
      { pl: "Buy $15.00 of S&P 500 at about $771.22/share (0.0194 share)? Reply YES and your PIN within 2 min to confirm, NO to cancel. Ref 7QX2D", think: 1100 },
      { you: YES },
      { sys: "The SMS operator proposes the trade", ops: { sms: "proposed" }, tally: ["1 of 3", "waiting for a checker"], tone: "wait", hold: 1000 },
      { ops: { price: "confirmed" }, tally: ["2 of 3", "approved in 5.8 s"], tone: "ok", hold: 800 },
      { pl: "Done: bought 0.0194 share S&P 500 for $15.00 at $771.22/share. Cash $85.00. Ref 7QX2D", think: 700 },
    ],
  },
  {
    id: "down2",
    label: "2 nodes down",
    note: "Measured on LocalNet: with two operators stopped, a trade times out after 30 s and nothing moves.",
    start: { price: "offline", risk: "offline" },
    steps: [
      { sys: "Both checkers are offline", tally: ["1 operator online", "not enough to approve"], tone: "bad", hold: 1000 },
      { you: "BUY GOLD 20" },
      { pl: "Buy $20.00 of Gold at about $4,145.59/oz (0.00482 oz)? Reply YES and your PIN within 2 min to confirm, NO to cancel. Ref 2WJ8C", think: 1100 },
      { you: YES },
      { sys: "The SMS operator proposes the trade", ops: { sms: "proposed" }, tally: ["1 of 3", "waiting for a second operator"], tone: "wait", hold: 1500 },
      { sys: "30 seconds pass, and no second operator agrees", tally: ["Not approved", "timed out after 30 s"], tone: "bad", hold: 1100 },
      { pl: "Not done: not enough operators approved it in time (2 of 3 are needed). No money moved. Ref 2WJ8C", think: 800 },
    ],
  },
];
