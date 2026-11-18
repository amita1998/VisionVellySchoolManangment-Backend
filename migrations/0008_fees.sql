-- 0008_fees.sql
-- Offline fee collection. Ledger style: payments are never deleted, a mistake is
-- corrected by a reversal row that points at the original payment.

CREATE TABLE fee_categories (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX fee_categories_name_key ON fee_categories (lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX fee_categories_code_key ON fee_categories (lower(code)) WHERE deleted_at IS NULL;

CREATE TRIGGER fee_categories_set_updated_at BEFORE UPDATE ON fee_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE fee_structures (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  class_id         INTEGER NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  category_id      INTEGER NOT NULL REFERENCES fee_categories (id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  total_amount     NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
  installment_plan installment_plan NOT NULL DEFAULT 'quarterly',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT fee_structures_one_per_class_category UNIQUE (academic_year_id, class_id, category_id)
);

CREATE INDEX fee_structures_lookup_idx ON fee_structures (academic_year_id, class_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER fee_structures_set_updated_at BEFORE UPDATE ON fee_structures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fee_installments (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fee_structure_id INTEGER NOT NULL REFERENCES fee_structures (id) ON DELETE CASCADE,
  seq              SMALLINT NOT NULL CHECK (seq > 0),
  label            TEXT NOT NULL,
  due_date         DATE NOT NULL,
  amount           NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fee_installments_unique_seq UNIQUE (fee_structure_id, seq)
);

CREATE INDEX fee_installments_due_idx ON fee_installments (due_date);

-- ---------------------------------------------------------------------------
-- A student's payable amount for one fee structure. Concession is applied once,
-- here, so every downstream number is reproducible.
-- ---------------------------------------------------------------------------

CREATE TABLE student_fees (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id         INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  academic_year_id   INTEGER NOT NULL REFERENCES academic_years (id) ON DELETE RESTRICT,
  fee_structure_id   INTEGER NOT NULL REFERENCES fee_structures (id) ON DELETE RESTRICT,
  gross_amount       NUMERIC(12, 2) NOT NULL CHECK (gross_amount >= 0),
  concession_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (concession_amount >= 0),
  concession_reason  TEXT,
  payable_amount     NUMERIC(12, 2) GENERATED ALWAYS AS (gross_amount - concession_amount) STORED,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_fees_unique UNIQUE (student_id, fee_structure_id),
  CONSTRAINT student_fees_concession_within_gross CHECK (concession_amount <= gross_amount)
);

CREATE INDEX student_fees_student_idx ON student_fees (student_id, academic_year_id);

CREATE TRIGGER student_fees_set_updated_at BEFORE UPDATE ON student_fees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE fee_payments (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_fee_id        INTEGER NOT NULL REFERENCES student_fees (id) ON DELETE RESTRICT,
  amount                NUMERIC(12, 2) NOT NULL CHECK (amount <> 0),
  payment_mode          payment_mode NOT NULL,
  reference_no          TEXT,
  paid_on               DATE NOT NULL,
  remarks               TEXT,
  recorded_by           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  is_reversal           BOOLEAN NOT NULL DEFAULT FALSE,
  reversal_of_payment_id INTEGER REFERENCES fee_payments (id) ON DELETE RESTRICT,
  reversal_reason       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fee_payments_reversal_shape CHECK (
    (is_reversal = FALSE AND reversal_of_payment_id IS NULL AND amount > 0)
    OR (is_reversal = TRUE AND reversal_of_payment_id IS NOT NULL AND amount < 0
        AND reversal_reason IS NOT NULL)
  ),
  CONSTRAINT fee_payments_reference_required CHECK (
    payment_mode = 'cash' OR is_reversal OR reference_no IS NOT NULL
  )
);

CREATE INDEX fee_payments_student_fee_idx ON fee_payments (student_fee_id);
CREATE INDEX fee_payments_paid_on_idx ON fee_payments (paid_on);
CREATE UNIQUE INDEX fee_payments_one_reversal ON fee_payments (reversal_of_payment_id)
  WHERE is_reversal;

-- ---------------------------------------------------------------------------
-- One receipt per real payment. Reversal entries carry no receipt of their own;
-- they mark the original receipt as reversed.
-- ---------------------------------------------------------------------------

CREATE TABLE fee_receipts (
  id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no             TEXT NOT NULL DEFAULT ('VVS-RCP-' || lpad(nextval('receipt_no_seq')::text, 6, '0')),
  payment_id             INTEGER NOT NULL UNIQUE REFERENCES fee_payments (id) ON DELETE RESTRICT,
  student_fee_id         INTEGER NOT NULL REFERENCES student_fees (id) ON DELETE RESTRICT,
  student_id             INTEGER NOT NULL REFERENCES students (id) ON DELETE RESTRICT,
  amount                 NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  issued_on              DATE NOT NULL,
  issued_by              INTEGER REFERENCES users (id) ON DELETE SET NULL,
  is_reversed            BOOLEAN NOT NULL DEFAULT FALSE,
  reversed_on            DATE,
  reversed_by_payment_id INTEGER REFERENCES fee_payments (id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fee_receipts_number_format CHECK (receipt_no ~ '^VVS-RCP-\d{6,}$')
);

CREATE UNIQUE INDEX fee_receipts_number_key ON fee_receipts (receipt_no);
CREATE INDEX fee_receipts_student_idx ON fee_receipts (student_id, issued_on DESC);
