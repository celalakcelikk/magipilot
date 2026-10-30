package api

import (
	"encoding/json"
	"net/http"
)

type createUserRequest struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Store interface {
	CreateUser(name, email string) (int64, error)
}

func CreateUserHandler(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			<FILL>http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return</FILL>
		}
		if req.Name == "" || req.Email == "" {
			http.Error(w, "name and email are required", http.StatusUnprocessableEntity)
			return
		}
		id, err := store.CreateUser(req.Name, req.Email)
		if err != nil {
			http.Error(w, "could not create user", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]int64{"id": id})
	}
}
