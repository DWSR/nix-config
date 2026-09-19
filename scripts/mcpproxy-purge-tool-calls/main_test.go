package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"go.etcd.io/bbolt"
)

func TestPurgeDeletesOnlyMatchingTopLevelBuckets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.db")
	db := openTestDB(t, path)

	if err := db.Update(func(tx *bbolt.Tx) error {
		for bucketName, records := range map[string][]string{
			"server_github_tool_calls": {"call-1", "call-2"},
			"server_slack_tool_calls":  {"call-3"},
			"server_github_tools":      {"tool-1"},
			"server_tool_calls":        {"call-4"},
			"server__tool_calls":       {"call-5"},
			"tool_calls":               {"call-6"},
		} {
			bucket, err := tx.CreateBucket([]byte(bucketName))
			if err != nil {
				return err
			}
			for _, key := range records {
				if err := bucket.Put([]byte(key), []byte("value")); err != nil {
					return err
				}
			}
		}

		parent, err := tx.CreateBucket([]byte("unrelated"))
		if err != nil {
			return err
		}
		nested, err := parent.CreateBucket([]byte("server_nested_tool_calls"))
		if err != nil {
			return err
		}
		return nested.Put([]byte("call-5"), []byte("value"))
	}); err != nil {
		t.Fatalf("seed database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close seeded database: %v", err)
	}

	got, err := purge(path)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	want := result{
		BucketsDeleted: 2,
		RecordsDeleted: 3,
		Buckets: []string{
			"server_github_tool_calls",
			"server_slack_tool_calls",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("result mismatch:\n got: %#v\nwant: %#v", got, want)
	}

	db = openTestDB(t, path)
	defer db.Close()
	if err := db.View(func(tx *bbolt.Tx) error {
		for _, name := range want.Buckets {
			if tx.Bucket([]byte(name)) != nil {
				t.Errorf("matching top-level bucket %q survived", name)
			}
		}
		if tx.Bucket([]byte("server_github_tools")) == nil {
			t.Error("unrelated top-level bucket was deleted")
		}
		for _, name := range []string{"server_tool_calls", "server__tool_calls"} {
			if tx.Bucket([]byte(name)) == nil {
				t.Errorf("bucket without a server ID %q was deleted", name)
			}
		}
		parent := tx.Bucket([]byte("unrelated"))
		if parent == nil || parent.Bucket([]byte("server_nested_tool_calls")) == nil {
			t.Error("matching nested bucket was deleted")
		}
		return nil
	}); err != nil {
		t.Fatalf("verify database: %v", err)
	}
}

func TestPurgeRefusesLockedDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.db")
	db := openTestDB(t, path)
	defer db.Close()

	started := time.Now()
	_, err := purge(path)
	if !errors.Is(err, errDatabaseLocked) {
		t.Fatalf("expected locked database error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("lock refusal took %s; expected no more than 1s", elapsed)
	}
}

func TestPurgeDoesNotCreateMissingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	if _, err := purge(path); err == nil {
		t.Fatal("expected missing database error")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing database was created: %v", err)
	}
}

func openTestDB(t *testing.T, path string) *bbolt.DB {
	t.Helper()
	db, err := bbolt.Open(path, 0o600, nil)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	return db
}
