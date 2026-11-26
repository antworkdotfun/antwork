# antwork x orbio.so: the Orbio House and the Key Desk

orbio.so is the AI protocol on Robinhood Chain where one CREDIT pays for one dollar of AI usage. antwork and orbio.so
work together: there is an Orbio House on the Hill, and its Key Desk puts the orbio.so CREDIT book one key press away
from every player.

## In the game

- **Orbio House**: a marble pavilion on the meadow next to the Fest Shuttle, with the orbio mark (a marble orb in a
  brass ring) on the roof. Open the map with M to find it.
- **Hosts**: Iris (orbio.so in a sentence), Bram (how an Orbio key is made) and Noor (the house and the orb).
- **Orbio Key Desk**: press E at the desk, or ask Bram. A card shows, read from Robinhood Chain:
  - the best price on the orbio.so CREDIT book in USDG, its distance from face value, the CREDIT on the book and the
    book fee;
  - the connected wallet's CREDIT balance (watchers see a prompt to connect);
  - when it was read. If every read fails it shows an error and Check again, never a made-up number.
- **Getting CREDIT** happens on orbio.so: "Get CREDIT on orbio.so" and "Your Orbio key" open https://www.orbio.so.
  Nothing is bought, approved or signed inside antwork. Activated CREDIT is a service balance for AI usage, not cash.

## Addresses (Robinhood Chain, chain id 4663)

| | address |
| --- | --- |
| CREDIT (6 decimals) | `0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C` |
| orbio.so Exchange (the CREDIT book) | `0x6951fFd32630b05e06F50062AEA801625A58eBC0` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

## How the desk reads the chain

Some networks block Robinhood Chain's public endpoints. The desk races two roads and shows the first full answer:

1. the game's own `eth_call`s (the public RPC, then the wallet's own RPC);
2. the festival server reads the chain for the player: `GET https://antwork-realm.fly.dev/orbio?addr=0x...`
   (address optional, 30 requests a minute per IP), which answers
   `{ bestPrice, discount, depthCredit, depthUsdg, levels, feeBps, credit, at, chainId, exchange }`.

Reads are reused for 15 seconds. The client side is in [engine/web3/orbio.js](../engine/web3/orbio.js) (an excerpt).

## For agents

An agent that walks the Hill over MCP (see [AGENTS.md](AGENTS.md)) can use an Orbio key to pay for its own model
requests, over MCP or the API, with the same key and balance.
