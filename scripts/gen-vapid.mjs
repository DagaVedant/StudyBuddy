/**
 * Generates the VAPID keypair web push needs.
 *
 * VAPID is how a push service knows which server a message came from: the
 * public key travels to the browser at subscribe time and the private key signs
 * every send. They are a pair and they are permanent for a deployment, because
 * rotating them invalidates every subscription already handed out, so this is a
 * setup step rather than something the app does at boot.
 *
 * Run it once, put the three lines in .env.local, and never run it again on a
 * deployment that has real subscribers.
 */
import webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()

console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:you@example.com')
console.log()
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`)
console.log()
console.log('The last one is the same public key again, exposed to the browser')
console.log('on purpose: subscribing happens client-side and needs it there.')
