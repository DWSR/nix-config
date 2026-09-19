package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"go.etcd.io/bbolt"
)

const lockTimeout = 100 * time.Millisecond

const (
	toolCallsBucketPrefix = "server_"
	toolCallsBucketSuffix = "_tool_calls"
)

var errDatabaseLocked = errors.New("database is locked; stop mcpproxy before running this command")

type result struct {
	BucketsDeleted int      `json:"buckets_deleted"`
	RecordsDeleted int      `json:"records_deleted"`
	Buckets        []string `json:"buckets"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: mcpproxy-purge-tool-calls <config.db>")
		os.Exit(2)
	}

	res, err := purge(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "purge tool-call history: %v\n", err)
		os.Exit(1)
	}

	if err := json.NewEncoder(os.Stdout).Encode(res); err != nil {
		fmt.Fprintf(os.Stderr, "encode result: %v\n", err)
		os.Exit(1)
	}
}

func purge(path string) (res result, err error) {
	info, err := os.Stat(path)
	if err != nil {
		return res, fmt.Errorf("stat database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return res, fmt.Errorf("database is not a regular file: %s", path)
	}

	db, err := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: lockTimeout})
	if errors.Is(err, bbolt.ErrTimeout) {
		return res, errDatabaseLocked
	}
	if err != nil {
		return res, fmt.Errorf("open database: %w", err)
	}
	defer func() {
		if closeErr := db.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close database: %w", closeErr)
		}
	}()

	res.Buckets = make([]string, 0)
	err = db.Update(func(tx *bbolt.Tx) error {
		if err := tx.ForEach(func(name []byte, bucket *bbolt.Bucket) error {
			bucketName := string(name)
			if bucket != nil && isToolCallsBucket(bucketName) {
				res.Buckets = append(res.Buckets, bucketName)
				res.RecordsDeleted += bucket.Stats().KeyN
			}
			return nil
		}); err != nil {
			return err
		}

		for _, bucketName := range res.Buckets {
			if err := tx.DeleteBucket([]byte(bucketName)); err != nil {
				return fmt.Errorf("delete bucket %s: %w", bucketName, err)
			}
		}
		res.BucketsDeleted = len(res.Buckets)
		return nil
	})
	if err != nil {
		return result{}, fmt.Errorf("update database: %w", err)
	}

	return res, nil
}

func isToolCallsBucket(name string) bool {
	return strings.HasPrefix(name, toolCallsBucketPrefix) &&
		strings.HasSuffix(name, toolCallsBucketSuffix) &&
		len(name) > len(toolCallsBucketPrefix)+len(toolCallsBucketSuffix)
}
