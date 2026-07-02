package store

import (
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type User struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Username string `gorm:"uniqueIndex;not null"     json:"username"`
	Password string `gorm:"not null"                 json:"-"` // never serialise password
	Email    string `gorm:"uniqueIndex;not null"     json:"email"`
}

func Connect(dsn string) *gorm.DB {
	if dsn == "" {
		log.Fatal("DATABASE_URL env var is required")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	return db
}

func Migrate(db *gorm.DB) {
	if err := db.AutoMigrate(&User{}); err != nil {
		log.Fatalf("migration failed: %v", err)
	}
}
