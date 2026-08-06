-- ============================================================================
-- Arabic search normalisation.
--
-- Corrects an assumption made one migration earlier. That migration built the
-- search vector with f_unaccent() and claimed it would strip Arabic tashkeel.
-- It does not. Postgres' unaccent dictionary is driven by unaccent.rules, which
-- covers Latin-script diacritics and nothing else:
--
--     SELECT f_unaccent('مُسْتَنَد');   -- → 'مُسْتَنَد', unchanged
--
-- So a user searching مستند would not find مُسْتَنَد, and the two spellings are
-- the same word. In a product whose whole premise is Arabic and English
-- documents, that is a broken search, not a rough edge.
--
-- f_normalize() replaces it and does four things, in this order:
--
--   1. unaccent      — Latin diacritics: Résumé → Resume
--   2. strip tashkeel — U+064B..U+0652 (fathatan…sukun), U+0670 (superscript
--                       alef), U+0640 (tatweel, a purely decorative stretch)
--   3. fold variants  — أ إ آ ٱ → ا, ى → ي, ة → ه. These are typed
--                       interchangeably; treating them as distinct characters
--                       makes search depend on which key someone happened to
--                       press.
--   4. lower          — LAST, deliberately. Running it first leaves 'CAFÉ' as
--                       'cafE', because this collation will not lowercase É
--                       until unaccent has already reduced it to E.
--
-- Both the trigger and every query call this one function, so the index and the
-- query string can never normalise differently — which would silently return
-- nothing rather than fail loudly.
-- ============================================================================

CREATE OR REPLACE FUNCTION f_normalize(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT lower(
           translate(
             regexp_replace(
               public.unaccent('public.unaccent'::regdictionary, $1),
               U&'[\064B-\0652\0670\0640]',
               '',
               'g'
             ),
             U&'\0623\0625\0622\0671\0649\0629',  -- أ إ آ ٱ ى ة
             U&'\0627\0627\0627\0627\064A\0647'   -- ا ا ا ا ي ه
           )
         )
$$;

-- Rebuild the trigger body against the new function. Weights are unchanged:
-- A title · B keywords · C description + summary · D extracted body text.
CREATE OR REPLACE FUNCTION document_metadata_search_vector_update()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
       setweight(to_tsvector('simple', f_normalize(coalesce(NEW.title, ''))), 'A')
    || setweight(to_tsvector('simple', f_normalize(coalesce(array_to_string(NEW.keywords, ' '), ''))), 'B')
    || setweight(to_tsvector('simple', f_normalize(coalesce(NEW.description, ''))), 'C')
    || setweight(to_tsvector('simple', f_normalize(coalesce(NEW.summary, ''))), 'C')
    || setweight(to_tsvector('simple', f_normalize(coalesce(NEW.extracted_text, ''))), 'D');
  RETURN NEW;
END
$$;

-- Re-index everything already stored: rows written under the old function hold
-- vectors that will not match a normalised query.
UPDATE "document_metadata" SET title = title;

-- f_unaccent() is left in place. It is a correct, generally useful function and
-- dropping it would break any migration that still references it.
