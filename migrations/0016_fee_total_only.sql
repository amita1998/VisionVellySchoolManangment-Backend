-- 0016_fee_total_only.sql
-- One total fee per class: the category dimension is gone.
--
-- Why keep the column instead of dropping it: historical rows (and any report a school has already
-- printed) still carry a category, and dropping a NOT NULL FK column rewrites data that already
-- exists. Making it nullable + a partial unique index per class gives the simple model the owner
-- asked for ("sirf total fees") without an irreversible change:
--
--   * category_id = NULL  -> the single total fee of that class for the year
--   * category_id set      -> a legacy row, still readable
--
-- The uniqueness therefore moves from (year, class, category) to (year, class) for the NULL rows.

ALTER TABLE fee_structures ALTER COLUMN category_id DROP NOT NULL;

ALTER TABLE fee_structures DROP CONSTRAINT IF EXISTS fee_structures_one_per_class_category;

CREATE UNIQUE INDEX fee_structures_one_total_per_class
  ON fee_structures (academic_year_id, class_id)
  WHERE category_id IS NULL AND deleted_at IS NULL;

-- Existing structures become the class total, then the category reference data goes away.
UPDATE fee_structures SET category_id = NULL WHERE category_id IS NOT NULL;
DELETE FROM fee_categories;
