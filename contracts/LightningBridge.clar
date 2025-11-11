(define-constant ERR-INVALID-AMOUNT u100)
(define-constant ERR-INVALID-INVOICE u101)
(define-constant ERR-INVOICE-NOT-FOUND u102)
(define-constant ERR-NOT-AUTHORIZED u103)
(define-constant ERR-SETTLE-FAILED u104)
(define-constant ERR-REFUND-FAILED u105)
(define-constant ERR-BRIDGE-PAUSED u106)
(define-constant ERR-INVALID-TIMEOUT u107)
(define-constant ERR-LOCK-FAILED u108)
(define-constant ERR-UNLOCK-FAILED u109)
(define-constant ERR-SBTC-TRANSFER-FAILED u110)
(define-constant ERR-ORACLE-NOT-VERIFIED u111)
(define-constant MAX-INVOICES u1000)
(define-constant DEFAULT-TIMEOUT u144)

(define-data-var next-invoice-id uint u0)
(define-data-var bridge-paused bool false)
(define-data-var authority principal tx-sender)
(define-data-var oracle-principal (optional principal) none)

(define-map invoices
  uint
  {
    invoice-hash: (buff 32),
    amount: uint,
    recipient: principal,
    sender: principal,
    timeout: uint,
    status: (string-ascii 20),
    timestamp: uint,
    sbtc-lock-txid: (optional (buff 32))
  }
)

(define-map invoice-by-hash
  (buff 32)
  uint
)

(define-read-only (get-invoice (id uint))
  (map-get? invoices id)
)

(define-read-only (get-invoice-by-hash (hash (buff 32)))
  (match (map-get? invoice-by-hash hash)
    id (ok id)
    (err u0)
  )
)

(define-read-only (is-bridge-active)
  (not (var-get bridge-paused))
)

(define-private (validate-amount (amt uint))
  (if (> amt u0)
    (ok true)
    (err ERR-INVALID-AMOUNT)
  )
)

(define-private (validate-invoice-hash (hash (buff 32)))
  (if (is-eq (len hash) u32)
    (ok true)
    (err ERR-INVALID-INVOICE)
  )
)

(define-private (validate-timeout (to uint))
  (if (and (> to u0) (<= to u1008))
    (ok true)
    (err ERR-INVALID-TIMEOUT)
  )
)

(define-private (is-authorized (caller principal))
  (or
    (is-eq caller (var-get authority))
    (is-some (var-get oracle-principal))
  )
)

(define-public (set-oracle (new-oracle principal))
  (begin
    (asserts! (is-eq tx-sender (var-get authority)) (err ERR-NOT-AUTHORIZED))
    (var-set oracle-principal (some new-oracle))
    (ok true)
  )
)

(define-public (pause-bridge (paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get authority)) (err ERR-NOT-AUTHORIZED))
    (var-set bridge-paused paused)
    (ok true)
  )
)

(define-public (generate-invoice
  (amount uint)
  (invoice-hash (buff 32))
  (recipient principal)
  (timeout (optional uint))
)
  (let
    (
      (next-id (var-get next-invoice-id))
      (use-timeout (default-to DEFAULT-TIMEOUT timeout))
    )
    (asserts! (<= next-id MAX-INVOICES) (err u1))
    (asserts! (is-bridge-active) (err ERR-BRIDGE-PAUSED))
    (try! (validate-amount amount))
    (try! (validate-invoice-hash invoice-hash))
    (try! (validate-timeout use-timeout))
    (asserts! (is-none (map-get? invoice-by-hash invoice-hash)) (err ERR-INVOICE-NOT-FOUND))
    (map-set invoices next-id
      {
        invoice-hash: invoice-hash,
        amount: amount,
        recipient: recipient,
        sender: tx-sender,
        timeout: (+ block-height use-timeout),
        status: "pending",
        timestamp: block-height,
        sbtc-lock-txid: none
      }
    )
    (map-set invoice-by-hash invoice-hash next-id)
    (var-set next-invoice-id (+ next-id u1))
    (print { event: "invoice-generated", id: next-id, hash: invoice-hash })
    (ok next-id)
  )
)

(define-public (lock-for-invoice
  (invoice-id uint)
  (sbtc-amount uint)
)
  (let
    (
      (inv (unwrap! (map-get? invoices invoice-id) (err ERR-INVOICE-NOT-FOUND)))
      (expected-amount (get amount inv))
    )
    (asserts! (is-eq sbtc-amount expected-amount) (err ERR-INVALID-AMOUNT))
    (asserts! (is-eq (get status inv) "pending") (err u1))
    (asserts! (is-eq tx-sender (get sender inv)) (err ERR-NOT-AUTHORIZED))
    (map-set invoices invoice-id
      (merge inv
        {
          status: "locked",
          sbtc-lock-txid: (some (sha256 (concat (to-consensus-buff? invoice-id) (to-consensus-buff? block-height))))
        }
      )
    )
    (print { event: "sbtc-locked", id: invoice-id })
    (ok true)
  )
)

(define-public (settle-invoice
  (invoice-id uint)
  (preimage (buff 32))
)
  (let
    (
      (inv (unwrap! (map-get? invoices invoice-id) (err ERR-INVOICE-NOT-FOUND)))
      (computed-hash (sha256 preimage))
    )
    (asserts! (is-eq computed-hash (get invoice-hash inv)) (err ERR-INVALID-INVOICE))
    (asserts! (is-eq (get status inv) "locked") (err u1))
    (asserts! (is-some (var-get oracle-principal)) (err ERR-ORACLE-NOT-VERIFIED))
    (asserts! (is-eq tx-sender (unwrap-panic (var-get oracle-principal))) (err ERR-NOT-AUTHORIZED))
    (map-set invoices invoice-id
      (merge inv
        {
          status: "settled",
          timestamp: block-height
        }
      )
    )
    (print { event: "invoice-settled", id: invoice-id, preimage: preimage })
    (ok true)
  )
)

(define-public (refund-invoice (invoice-id uint))
  (let
    (
      (inv (unwrap! (map-get? invoices invoice-id) (err ERR-INVOICE-NOT-FOUND)))
    )
    (asserts! (or
      (is-eq (get status inv) "locked")
      (is-eq (get status inv) "pending")
    ) (err u1))
    (asserts! (>= block-height (get timeout inv)) (err u1))
    (asserts! (is-eq tx-sender (get sender inv)) (err ERR-NOT-AUTHORIZED))
    (map-set invoices invoice-id
      (merge inv
        {
          status: (if (is-some (get sbtc-lock-txid inv)) "refunded" "expired"),
          timestamp: block-height
        }
      )
    )
    (print { event: "invoice-refunded", id: invoice-id })
    (ok true)
  )
)

(define-public (expire-invoices)
  (begin
    (asserts! (is-eq tx-sender (var-get authority)) (err ERR-NOT-AUTHORIZED))
    (ok u0)
  )
)