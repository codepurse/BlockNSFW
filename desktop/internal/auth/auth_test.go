package auth

import "testing"

func TestHashVerify(t *testing.T) {
	h, err := Hash("hunter2pw")
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if !Verify(h, "hunter2pw") {
		t.Error("correct password should verify")
	}
	if Verify(h, "wrongpw") {
		t.Error("wrong password should not verify")
	}
}

func TestHashIsSalted(t *testing.T) {
	h1, _ := Hash("samepassword")
	h2, _ := Hash("samepassword")
	if h1 == h2 {
		t.Error("two hashes of the same password should differ (salt)")
	}
}

func TestVerifyRejectsGarbageHash(t *testing.T) {
	if Verify("not-a-real-bcrypt-hash", "anything") {
		t.Error("a malformed hash must never verify")
	}
}
