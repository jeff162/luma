-- The oldest tenant schema the migration chain supports upgrading: what `init_db` created at version 17
-- (commit 78cc114, the last one at CURRENT_VERSION = 17). The fresh-vs-upgraded check starts here.
--
-- Captured by running that commit's `init_db` against an empty file and reading back `sqlite_master`.
-- It is history: never edit it to follow a schema change.

CREATE TABLE plaid_item (
                item_id          TEXT PRIMARY KEY,
                access_token     TEXT NOT NULL DEFAULT '',
                access_token_enc TEXT
            );
CREATE TABLE category (
                id                  TEXT PRIMARY KEY,
                parent_id           TEXT REFERENCES category(id) ON DELETE SET NULL,
                name                TEXT NOT NULL,
                category_type       TEXT,
                sort_order          INTEGER NOT NULL DEFAULT 0,
                exclude_from_totals INTEGER NOT NULL DEFAULT 0,
                system_key          TEXT,
                import_source_batch_id TEXT REFERENCES import_batch(id) ON DELETE SET NULL,
                is_active           INTEGER NOT NULL DEFAULT 1,
                set_aside           INTEGER NOT NULL DEFAULT 0,
                import_pending      INTEGER NOT NULL DEFAULT 0
            );
CREATE TABLE category_rule (
                id           TEXT PRIMARY KEY,
                category_id  TEXT REFERENCES category(id) ON DELETE CASCADE,
                keyword      TEXT NOT NULL,
                amount_min   REAL,
                amount_max   REAL,
                debit_credit TEXT NOT NULL DEFAULT 'both',
                clean_name   TEXT,
                owner_id     TEXT REFERENCES owner(id) ON DELETE SET NULL,
                account_id   TEXT REFERENCES account(id) ON DELETE SET NULL,
                -- Optional scope by account *type* (e.g. 'paypal', 'amazon'): the rule matches only rows
                -- whose effective account is of this type. Parallel to account_id but covers every account
                -- of the type with one rule. Part of the matcher identity; precedence account_id > type.
                account_type TEXT,
                -- 1 = also match the rule's keyword against the row's captured import source text
                -- (description + extra evidence fields like "Original Statement"), not just the
                -- merchant/raw/display name. Opt-in per rule; part of the rule's matcher identity.
                match_source_text INTEGER NOT NULL DEFAULT 0,
                -- Optional multi-clause merchant matcher (JSON) that supersedes the single-substring
                -- `keyword` when present: {"op":"and","clauses":[{"type":"contains","text":"…"}, …]}.
                -- v1 is AND-only / contains-only — every clause's text must be a substring of the row's
                -- name (or source text). `keyword` mirrors the sorted, joined clause texts so search and
                -- LENGTH-based specificity ordering keep working; NULL match_expr = a plain keyword rule.
                match_expr TEXT,
                -- 1 = this rule declares a recurring series: its matches are members of the
                -- recurring_series row that points back here via rule_id (see recurring_series).
                is_recurring INTEGER NOT NULL DEFAULT 0,
                -- The newest transaction *date* this rule has applied a live effect (category/rename/tag) to,
                -- kept as a monotonic-forward max. Powers the stale-rule cleanup + sort. NULL = never applied.
                last_effect_date TEXT,
                -- Soft-delete marker for the rules trash: non-NULL = trashed (recoverable). The categorizer
                -- and matcher-identity ignore trashed rules; the row survives for restore/purge.
                deleted_at TEXT,
                -- 1 = app-managed rule (auto-created money-movement Type rules); excluded from stale-rule cleanup.
                is_managed INTEGER NOT NULL DEFAULT 0
            );
CREATE TABLE owner (
                id    TEXT PRIMARY KEY,
                name  TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#6366f1'
            );
CREATE TABLE account (
                id               TEXT PRIMARY KEY,
                plaid_account_id TEXT UNIQUE,
                plaid_item_id    TEXT NOT NULL,
                name             TEXT NOT NULL,
                display_name     TEXT NOT NULL,
                institution      TEXT,
                type             TEXT,
                subtype          TEXT,
                mask             TEXT,
                owner_id         TEXT REFERENCES owner(id) ON DELETE SET NULL,
                parent_account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
                trashed_at       TEXT
            );
CREATE TABLE txn (
                id                   TEXT PRIMARY KEY,
                plaid_transaction_id TEXT UNIQUE,
                account_id           TEXT NOT NULL REFERENCES account(id),
                category_id          TEXT REFERENCES category(id) ON DELETE SET NULL,
                amount               REAL NOT NULL,
                merchant_name        TEXT,
                display_name         TEXT,
                raw_name             TEXT,
                date                 TEXT NOT NULL,
                is_pending           INTEGER NOT NULL DEFAULT 0,
                category_overridden  INTEGER NOT NULL DEFAULT 0,
                category_source      TEXT,
                -- Provenance of display_name, mirroring category_source: 'manual' (a deliberate
                -- rename — protected forever, never overwritten by rules/enrichment), 'rule' (a rule's
                -- clean_name owns the name), 'import' (the imported/synced name), 'enrichment' (a
                -- reconciliation source filled it). NULL = unknown/legacy, treated as non-manual
                -- (can be enriched). This gives display_name the provenance category_source already has.
                display_name_source  TEXT,
                imported_category    TEXT,
                notes                TEXT,
                owner_id             TEXT REFERENCES owner(id) ON DELETE SET NULL,
                content_hash         TEXT,
                import_evidence_json TEXT,
                import_batch_id      TEXT REFERENCES import_batch(id) ON DELETE SET NULL,
                trashed_at           TEXT,
                suspect_duplicate_of     TEXT,
                suspect_duplicate_reason TEXT,
                suspect_resolved_at      TEXT,
                rejection_reason         TEXT,
                dedupe_resolved_by       TEXT,
                -- 1 = freshly imported/synced and not yet looked over. A user convenience for
                -- reviewing newly arrived transactions; cleared by a manual category edit or an
                -- explicit "mark reviewed". Default 0 keeps existing and hand-created rows out of
                -- the review pool. Not a tag: review is workflow lifecycle, not a reporting label.
                needs_review             INTEGER NOT NULL DEFAULT 0,
                -- Membership link to a detected/confirmed recurring series (see recurring_series).
                -- NULL = not part of any recurring series. Recomputed by the recurring detector on
                -- each scan; a match cache, not user-authored.
                recurring_series_id      TEXT REFERENCES recurring_series(id) ON DELETE SET NULL
            );
CREATE TABLE tag (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                color      TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
CREATE TABLE rule_tag (
                rule_id TEXT NOT NULL REFERENCES category_rule(id) ON DELETE CASCADE,
                tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (rule_id, tag_id)
            );
CREATE TABLE txn_tag (
                txn_id       TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                tag_id       TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                rule_present INTEGER NOT NULL DEFAULT 0,
                manual_state INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (txn_id, tag_id)
            );
CREATE TABLE category_tag (
                category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
                tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (category_id, tag_id)
            );
CREATE TABLE account_tag (
                account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
                PRIMARY KEY (account_id, tag_id)
            );
CREATE TABLE account_pair_distinct (
                account_id_low  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                account_id_high TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
                asserted_at     TEXT NOT NULL,
                PRIMARY KEY (account_id_low, account_id_high),
                CHECK (account_id_low < account_id_high)
            );
CREATE TABLE amazon_charge_distinct (
                txn_id_low  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                txn_id_high TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                asserted_at TEXT NOT NULL,
                PRIMARY KEY (txn_id_low, txn_id_high),
                CHECK (txn_id_low < txn_id_high)
            );
CREATE TABLE amazon_charge_reviewed (
                txn_id      TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
                reviewed_at TEXT NOT NULL
            );
CREATE TABLE amazon_pending_item (
                order_id         TEXT PRIMARY KEY,
                items_json       TEXT NOT NULL,
                source_file      TEXT,
                source_file_hash TEXT,
                parked_batch_id  TEXT,
                created_at       TEXT NOT NULL DEFAULT (datetime('now'))
            );
CREATE TABLE ui_preference (
                scope_id   TEXT NOT NULL,
                pref_key   TEXT NOT NULL,
                pref_value TEXT NOT NULL,
                updated_at TEXT,
                PRIMARY KEY (scope_id, pref_key)
            );
CREATE TABLE csv_import_profile (
                id                   TEXT PRIMARY KEY,
                name                 TEXT NOT NULL,
                filename_pattern     TEXT,
                header_fingerprint   TEXT,
                template_filename    TEXT,
                template_file_hash   TEXT,
                column_map           TEXT NOT NULL DEFAULT '{}',
                account_id           TEXT REFERENCES account(id) ON DELETE SET NULL,
                date_format          TEXT NOT NULL DEFAULT '%Y-%m-%d',
                amount_convention    TEXT NOT NULL DEFAULT 'single_signed',
                skip_rows            INTEGER NOT NULL DEFAULT 0,
                apply_categorization INTEGER NOT NULL DEFAULT 1,
                enrich_from_source   INTEGER NOT NULL DEFAULT 0,
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                notes                TEXT,
                source_kind          TEXT,
                created_at           TEXT NOT NULL DEFAULT (datetime('now'))
            );
CREATE TABLE import_batch (
                id               TEXT PRIMARY KEY,
                profile_id       TEXT REFERENCES csv_import_profile(id) ON DELETE SET NULL,
                filename         TEXT NOT NULL,
                file_content_hash TEXT,
                imported_at      TEXT NOT NULL DEFAULT (datetime('now')),
                row_count        INTEGER NOT NULL DEFAULT 0,
                skipped_count    INTEGER NOT NULL DEFAULT 0,
                deduped_count    INTEGER NOT NULL DEFAULT 0,
                status           TEXT NOT NULL DEFAULT 'completed',
                use_imported_categories INTEGER NOT NULL DEFAULT 0,
                config_snapshot  TEXT,
                -- Provenance class of the import, for history grouping. NULL = an ordinary CSV import;
                -- 'marketplace:<vendor>' (e.g. 'marketplace:amazon') marks a dedicated marketplace
                -- importer's batch so the history groups it under that vendor instead of "unknown source".
                source_kind      TEXT,
                -- Cached Amazon reconciliation "attention" count (a duplicate/split to resolve), with the
                -- global recon epoch (db_meta 'recon_epoch') it was computed at. Recomputed lazily only when
                -- the batch's epoch trails the current one; see amazon.reconciliation_attention_count and the
                -- recon-epoch triggers created after run_migrations. NULL = never computed.
                recon_attention_count INTEGER,
                recon_epoch      INTEGER
            );
CREATE TABLE import_batch_account (
                batch_id    TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                csv_value   TEXT NOT NULL,
                account_id  TEXT REFERENCES account(id) ON DELETE SET NULL,
                row_count   INTEGER NOT NULL DEFAULT 0,
                was_skipped INTEGER NOT NULL DEFAULT 0,
                coverage_start_date TEXT,
                coverage_end_date   TEXT,
                terminal_date       TEXT,
                PRIMARY KEY (batch_id, csv_value)
            );
CREATE TABLE import_batch_duplicate (
                batch_id                  TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
                row_number                INTEGER NOT NULL,
                reason                    TEXT NOT NULL,
                values_json               TEXT,
                matched_transaction_json  TEXT,
                txn_payload_json          TEXT,
                reviewed_at               TEXT,
                -- Enrich-on-duplicate outcome (see migration 7): the existing row this duplicate's novel
                -- detail was folded into, exactly what was added (for undo), and when. NULL = not enriched.
                enriched_txn_id           TEXT,
                enriched_delta_json       TEXT,
                enriched_at               TEXT,
                PRIMARY KEY (batch_id, row_number)
            );
CREATE TABLE backup_recipient (
                id          TEXT PRIMARY KEY,
                label       TEXT NOT NULL,
                public_key  TEXT NOT NULL,
                fingerprint TEXT NOT NULL UNIQUE,
                algorithm   TEXT NOT NULL DEFAULT 'rsa-oaep-sha256',
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
CREATE TABLE import_workflow_state (
                key          TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL DEFAULT '{}'
            );
CREATE TABLE recurring_series (
                id                TEXT PRIMARY KEY,
                payee_key         TEXT NOT NULL,
                display_name      TEXT,
                category_id       TEXT REFERENCES category(id) ON DELETE SET NULL,
                account_id        TEXT REFERENCES account(id) ON DELETE SET NULL,
                cadence           TEXT NOT NULL,
                period_days       INTEGER NOT NULL,
                expected_amount   REAL,
                amount_min        REAL,
                amount_max        REAL,
                last_txn_date     TEXT,
                next_due_date     TEXT,
                occurrence_count  INTEGER NOT NULL DEFAULT 0,
                confidence        REAL NOT NULL DEFAULT 0,
                status            TEXT NOT NULL DEFAULT 'active',
                -- 'auto' (detector), 'manual' (anchor-created), or 'rule' (rule-backed: membership is
                -- the linked rule's matches rather than the derived payee_key key).
                source            TEXT NOT NULL DEFAULT 'auto',
                -- Set only for source='rule' series: the category_rule whose matches are this series'
                -- members. ON DELETE SET NULL as a safety net; delete_rule drops the series explicitly.
                rule_id           TEXT REFERENCES category_rule(id) ON DELETE SET NULL,
                confirmed         INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT
            );
CREATE TABLE recurring_membership_override (
                txn_id     TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                series_id  TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
                state      TEXT NOT NULL,
                PRIMARY KEY (txn_id, series_id)
            );
CREATE TABLE txn_link (
                id            TEXT PRIMARY KEY,
                kind          TEXT NOT NULL,
                external_ref  TEXT,
                metadata_json TEXT,
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
CREATE TABLE txn_link_member (
                link_id TEXT NOT NULL REFERENCES txn_link(id) ON DELETE CASCADE,
                txn_id  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
                role    TEXT NOT NULL,
                PRIMARY KEY (link_id, txn_id)
            );
CREATE TABLE amazon_funding_map (
                id                 TEXT PRIMARY KEY,
                last4              TEXT NOT NULL,
                network            TEXT,
                amazon_account_id  TEXT REFERENCES account(id) ON DELETE CASCADE,
                funding_account_id TEXT REFERENCES account(id) ON DELETE CASCADE,
                created_at         TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
            );
CREATE TABLE merchant_rename (
            id          TEXT PRIMARY KEY,
            raw_pattern TEXT NOT NULL UNIQUE,
            clean_name  TEXT NOT NULL
        );
CREATE TABLE db_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
CREATE INDEX idx_category_active ON category(is_active);
CREATE INDEX idx_account_pair_distinct_high ON account_pair_distinct(account_id_high);
CREATE INDEX idx_amazon_charge_distinct_high ON amazon_charge_distinct(txn_id_high);
CREATE INDEX idx_ui_preference_scope ON ui_preference(scope_id);
CREATE INDEX idx_txn_date        ON txn(date);
CREATE INDEX idx_txn_account     ON txn(account_id);
CREATE INDEX idx_txn_category    ON txn(category_id);
CREATE INDEX idx_txn_owner       ON txn(owner_id);
CREATE INDEX idx_txn_batch       ON txn(import_batch_id);
CREATE INDEX idx_txn_hash        ON txn(content_hash);
CREATE UNIQUE INDEX idx_tag_name_unique ON tag(LOWER(TRIM(name)));
CREATE INDEX idx_tag_sort_order  ON tag(sort_order);
CREATE INDEX idx_rule_category   ON category_rule(category_id);
CREATE INDEX idx_rule_keyword    ON category_rule(keyword);
CREATE INDEX idx_rule_account    ON category_rule(account_id);
CREATE INDEX idx_rule_tag_tag    ON rule_tag(tag_id);
CREATE INDEX idx_account_owner   ON account(owner_id);
CREATE INDEX idx_txn_tag_tag     ON txn_tag(tag_id);
CREATE INDEX idx_category_tag_tag ON category_tag(tag_id);
CREATE INDEX idx_account_tag_tag ON account_tag(tag_id);
CREATE INDEX idx_import_batch_file_hash ON import_batch(file_content_hash);
CREATE INDEX idx_iba_account ON import_batch_account(account_id);
CREATE INDEX idx_iba_batch   ON import_batch_account(batch_id);
CREATE INDEX idx_import_batch_duplicate_batch ON import_batch_duplicate(batch_id);
CREATE INDEX idx_recurring_series_payee ON recurring_series(payee_key);
CREATE INDEX idx_txn_link_ref ON txn_link(kind, external_ref);
CREATE INDEX idx_txn_link_member_txn ON txn_link_member(txn_id);
CREATE UNIQUE INDEX idx_amazon_funding_global
                ON amazon_funding_map(last4, COALESCE(network, ''))
                WHERE amazon_account_id IS NULL;
CREATE UNIQUE INDEX idx_amazon_funding_override
                ON amazon_funding_map(last4, COALESCE(network, ''), amazon_account_id)
                WHERE amazon_account_id IS NOT NULL;
CREATE INDEX idx_rename_pattern ON merchant_rename(raw_pattern)
    ;
CREATE INDEX idx_txn_needs_review ON txn(needs_review) WHERE needs_review = 1;
CREATE INDEX idx_txn_recurring ON txn(recurring_series_id) WHERE recurring_series_id IS NOT NULL;
CREATE UNIQUE INDEX idx_recurring_override_pin ON recurring_membership_override(txn_id) WHERE state = 'pinned';
CREATE TRIGGER trg_recon_epoch_txn_insert
                AFTER INSERT ON txn
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_update
                AFTER UPDATE ON txn
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_delete
                AFTER DELETE ON txn
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_insert
                AFTER INSERT ON txn_link
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_update
                AFTER UPDATE ON txn_link
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_delete
                AFTER DELETE ON txn_link
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_member_insert
                AFTER INSERT ON txn_link_member
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_member_update
                AFTER UPDATE ON txn_link_member
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_txn_link_member_delete
                AFTER DELETE ON txn_link_member
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_account_insert
                AFTER INSERT ON account
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_account_update
                AFTER UPDATE ON account
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_account_delete
                AFTER DELETE ON account
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_funding_map_insert
                AFTER INSERT ON amazon_funding_map
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_funding_map_update
                AFTER UPDATE ON amazon_funding_map
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_funding_map_delete
                AFTER DELETE ON amazon_funding_map
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_charge_distinct_insert
                AFTER INSERT ON amazon_charge_distinct
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_charge_distinct_delete
                AFTER DELETE ON amazon_charge_distinct
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_charge_reviewed_insert
                AFTER INSERT ON amazon_charge_reviewed
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
CREATE TRIGGER trg_recon_epoch_amazon_charge_reviewed_delete
                AFTER DELETE ON amazon_charge_reviewed
                BEGIN
                    INSERT INTO db_meta (key, value) VALUES ('recon_epoch', 1)
                    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
                END;
