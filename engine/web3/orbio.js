// engine/web3/orbio.js: EXCERPT from the antwork client (src/web3/orbio.js), published for transparency.
// It imports modules of the game that are not in this repository (config.js, wallet.js), so it is for reading.

import { FEST } from '../game/config.js'
import { wallet } from './wallet.js'

// ============================================================================
// orbio.so for the Orbio House Key Desk (src/ui/OrbioCard.jsx). READ-ONLY:
// nothing here signs, approves or sends; buying CREDIT and making an Orbio key
// happen on orbio.so itself.
//
// orbio.so (our partner: the AI protocol where 1 CREDIT pays for 1 USD of AI usage) on Robinhood Chain (4663):
//   CREDIT   6 decimals, 1 CREDIT = 1 USD of AI usage at face value
//   Exchange the CREDIT book: bestPrice() (10000 = 1 USDG per CREDIT), depth(), feeBps()
//
// readOrbio(addr) races two paths, the first full answer wins (the readBalances
// pattern in wallet.js):
//   1. our own eth_calls (wallet.call: EVM_RPC, then the wallet's own RPC)
//   2. the realm reads the chain for us (GET /orbio): some ISPs block Robinhood Chain's hosts
// When both fail it throws: the card shows an error and Check again, never a made-up number.
// server/lib/orbio.js decodes the same calls for the realm.
// ============================================================================

export const ORBIO = Object.freeze({
  site: 'https://www.orbio.so',
  chainId: 4663,
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  scale: 10000,
  decimals: 6,
})

const SEL = { bestPrice: '0xf7a61202', depth: '0x631c56ef', feeBps: '0x24a9d853', balanceOf: '0x70a08231' }
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)

const word = (hex, i) => {
  const h = String(hex || '').replace(/^0x/, '')
  const w = h.slice(i * 64, i * 64 + 64)
  if (w.length !== 64) throw new Error('short answer')
  return BigInt('0x' + w)
}
const units = (atoms) => Number(atoms) / 10 ** ORBIO.decimals

export function decodeBook(bestHex, depthHex, feeHex) {
  const best = Number(word(bestHex, 0))
  const out = {
    bestPrice: best > 0 ? best / ORBIO.scale : null,
    discount: best > 0 ? Math.round((1 - best / ORBIO.scale) * 10000) / 100 : null,
    depthCredit: null,
    depthUsdg: null,
    levels: null,
    feeBps: null,
  }
  if (depthHex) {
    out.depthCredit = units(word(depthHex, 0))
    out.depthUsdg = units(word(depthHex, 1))
    out.levels = Number(word(depthHex, 2))
  }
  if (feeHex) out.feeBps = Number(word(feeHex, 0))
  return out
}

async function direct(addr) {
  const [b, d, f, bal] = await Promise.allSettled([
    wallet.call(ORBIO.exchange, SEL.bestPrice),
    wallet.call(ORBIO.exchange, SEL.depth),
    wallet.call(ORBIO.exchange, SEL.feeBps),
    addr ? wallet.call(ORBIO.credit, SEL.balanceOf + '0'.repeat(24) + addr.slice(2).toLowerCase()) : Promise.resolve(null),
  ])
  if (b.status !== 'fulfilled') throw b.reason
  if (addr && bal.status !== 'fulfilled') throw bal.reason // let the realm try for the whole answer
  const book = decodeBook(b.value, d.status === 'fulfilled' ? d.value : null, f.status === 'fulfilled' ? f.value : null)
  return { ...book, credit: addr ? units(word(bal.value, 0)) : null, via: 'chain', at: Date.now() }
}

async function viaRealm(addr) {
  const res = await fetch(`${FEST.REALM_URL}/orbio${addr ? `?addr=${addr}` : ''}`, { signal: AbortSignal.timeout(10000) })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error || `realm ${res.status}`)
  if (!('bestPrice' in j)) throw new Error('the realm sent no book')
  if (addr && typeof j.credit !== 'number') throw new Error('the realm could not read the balance')
  return {
    bestPrice: j.bestPrice,
    discount: j.discount,
    depthCredit: j.depthCredit ?? null,
    depthUsdg: j.depthUsdg ?? null,
    levels: j.levels ?? null,
    feeBps: j.feeBps ?? null,
    credit: addr ? j.credit : null,
    via: 'realm',
    at: Date.now(),
  }
}

/** The CREDIT book and (with a 0x address) that wallet's CREDIT. Throws when every path fails. */
// When the balance alone cannot be read anywhere, the book still shows and the
// balance says so (creditError), instead of a zero nobody read.
// A read is kept for 15 s (like orbio.chat's market()), so reopening the card is
// instant; `at` stays the time it was really read. force skips it (Check again).
let cache = null
export async function readOrbio(addr = null, { force = false } = {}) {
  const a = isAddr(addr) ? addr : null
  if (!force && cache && cache.addr === a && Date.now() - cache.data.at < 15000) return cache.data
  const race = (x) => Promise.any(FEST.REALM_URL ? [direct(x), viaRealm(x)] : [direct(x)])
  let data
  try {
    data = await race(a)
  } catch (e) {
    if (!a) throw e
    data = { ...(await race(null)), creditError: true }
  }
  cache = { addr: a, data }
  return data
}
