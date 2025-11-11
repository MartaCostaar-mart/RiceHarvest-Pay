(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-INVALID-SALARY-AMOUNT (err u101))
(define-constant ERR-INVALID-PAY-PERIOD (err u102))
(define-constant ERR-INVALID-WORKER-PRINCIPAL (err u103))
(define-constant ERR-ESCROW-ALREADY-EXISTS (err u104))
(define-constant ERR-ESCROW-NOT-FOUND (err u105))
(define-constant ERR-INVALID-TIMESTAMP (err u106))
(define-constant ERR-RELEASE-NOT-AUTHORIZED (err u107))
(define-constant ERR-REFUND-PERIOD-NOT-ENDED (err u108))
(define-constant ERR-INVALID-PROOF-HASH (err u109))
(define-constant ERR-MAX-ESCROWS-EXCEEDED (err u110))
(define-constant ERR-INVALID-REFUND-AMOUNT (err u111))
(define-constant ERR-ESCROW-ALREADY-RELEASED (err u112))

(define-data-var next-escrow-id uint u0)
(define-data-var max-escrows uint u500)
(define-data-var admin-principal principal tx-sender)

(define-map escrows
  uint
  {
    employer: principal,
    worker: principal,
    salary-amount: uint,
    pay-period-start: uint,
    pay-period-end: uint,
    token-contract: principal,
    proof-hash: (buff 32),
    status: (string-ascii 20),
    timestamp: uint,
    released-to: (optional principal)
  }
)

(define-map escrows-by-employer-worker
  { employer: principal, worker: principal }
  uint
)

(define-read-only (get-escrow (id uint))
  (map-get? escrows id)
)

(define-read-only (get-escrow-by-employer-worker (employer principal) (worker principal))
  (map-get? escrows-by-employer-worker { employer: employer, worker: worker })
)

(define-read-only (is-escrow-registered (employer principal) (worker principal))
  (is-some (map-get? escrows-by-employer-worker { employer: employer, worker: worker }))
)

(define-private (validate-salary-amount (amount uint))
  (if (> amount u0)
      (ok true)
      ERR-INVALID-SALARY-AMOUNT
  )
)

(define-private (validate-pay-period (start uint) (end uint))
  (if (and (> start u0) (> end start))
      (ok true)
      ERR-INVALID-PAY-PERIOD
  )
)

(define-private (validate-worker-principal (worker principal))
  (if (and (is-standard worker) (not (is-eq worker tx-sender)))
      (ok true)
      ERR-INVALID-WORKER-PRINCIPAL
  )
)

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height)
      (ok true)
      ERR-INVALID-TIMESTAMP
  )
)

(define-private (validate-proof-hash (hash (buff 32)))
  (ok true)
)

(define-public (set-admin-principal (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin-principal)) ERR-NOT-AUTHORIZED)
    (asserts! (is-standard new-admin) ERR-INVALID-WORKER-PRINCIPAL)
    (var-set admin-principal new-admin)
    (ok true)
  )
)

(define-public (set-max-escrows (new-max uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin-principal)) ERR-NOT-AUTHORIZED)
    (asserts! (> new-max u0) ERR-MAX-ESCROWS-EXCEEDED)
    (var-set max-escrows new-max)
    (ok true)
  )
)

(define-public (lock-salary
  (worker principal)
  (salary-amount uint)
  (pay-period-start uint)
  (pay-period-end uint)
  (token-contract principal)
  (proof-hash (buff 32))
)
  (let
    (
      (next-id (var-get next-escrow-id))
      (current-max (var-get max-escrows))
      (employer tx-sender)
    )
    (asserts! (< next-id current-max) ERR-MAX-ESCROWS-EXCEEDED)
    (try! (validate-worker-principal worker))
    (try! (validate-salary-amount salary-amount))
    (try! (validate-pay-period pay-period-start pay-period-end))
    (try! (validate-proof-hash proof-hash))
    (asserts! (is-none (map-get? escrows-by-employer-worker { employer: employer, worker: worker })) ERR-ESCROW-ALREADY-EXISTS)
    (try! (as-contract (contract-call? token-contract transfer salary-amount tx-sender (as-contract tx-sender) none)))
    (map-set escrows next-id
      {
        employer: employer,
        worker: worker,
        salary-amount: salary-amount,
        pay-period-start: pay-period-start,
        pay-period-end: pay-period-end,
        token-contract: token-contract,
        proof-hash: proof-hash,
        status: "locked",
        timestamp: block-height,
        released-to: none
      }
    )
    (map-set escrows-by-employer-worker { employer: employer, worker: worker } next-id)
    (var-set next-escrow-id (+ next-id u1))
    (print { event: "salary-locked", id: next-id })
    (ok next-id)
  )
)

(define-public (release-to-worker (id uint) (provided-hash (buff 32)))
  (let
    (
      (escrow-opt (map-get? escrows id))
    )
    (match escrow-opt
      escrow
        (begin
          (asserts! (is-eq (get proof-hash escrow) provided-hash) ERR-INVALID-PROOF-HASH)
          (asserts! (is-eq (get status escrow) "locked") ERR-ESCROW-ALREADY-RELEASED)
          (asserts! (>= block-height (get pay-period-end escrow)) ERR-REFUND-PERIOD-NOT-ENDED)
          (asserts! (or (is-eq tx-sender (get employer escrow)) (is-eq tx-sender (get worker escrow))) ERR-RELEASE-NOT-AUTHORIZED)
          (let
            (
              (amount (get salary-amount escrow))
              (token (get token-contract escrow))
              (worker (get worker escrow))
            )
            (try! (as-contract (contract-call? token transfer amount (as-contract tx-sender) worker none)))
            (map-set escrows id
              (merge escrow
                {
                  status: "released",
                  timestamp: block-height,
                  released-to: (some worker)
                }
              )
            )
            (print { event: "salary-released", id: id })
            (ok true)
          )
        )
      ERR-ESCROW-NOT-FOUND
    )
  )
)

(define-public (claim-refund (id uint))
  (let
    (
      (escrow-opt (map-get? escrows id))
    )
    (match escrow-opt
      escrow
        (begin
          (asserts! (is-eq tx-sender (get employer escrow)) ERR-NOT-AUTHORIZED)
          (asserts! (is-eq (get status escrow) "locked") ERR-ESCROW-ALREADY-RELEASED)
          (asserts! (> block-height (get pay-period-end escrow)) ERR-REFUND-PERIOD-NOT-ENDED)
          (let
            (
              (amount (get salary-amount escrow))
              (token (get token-contract escrow))
            )
            (try! (as-contract (contract-call? token transfer amount (as-contract tx-sender) tx-sender none)))
            (map-set escrows id
              (merge escrow
                {
                  status: "refunded",
                  timestamp: block-height,
                  released-to: none
                }
              )
            )
            (print { event: "refund-claimed", id: id })
            (ok true)
          )
        )
      ERR-ESCROW-NOT-FOUND
    )
  )
)

(define-public (get-escrow-count)
  (ok (var-get next-escrow-id))
)

(define-public (check-escrow-existence (employer principal) (worker principal))
  (ok (is-escrow-registered employer worker))
)