// Package auth hashes and verifies the uninstall password. Only the bcrypt hash
// is ever stored (by the scm package); the plaintext is verified in memory
// before any authorized teardown. This is the gate that makes uninstall require
// the parent/accountability-partner's password rather than just admin rights.
package auth

import "golang.org/x/crypto/bcrypt"

// MinLength is the shortest password we accept at set time.
const MinLength = 6

// Hash returns a salted bcrypt hash of the password.
func Hash(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Verify reports whether plain matches the stored bcrypt hash. It returns false
// for a malformed hash rather than erroring.
func Verify(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
