package store

import (
	"log"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type User struct {
	ID       uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Username string    `gorm:"uniqueIndex;not null"     json:"username"`
	Email    string    `gorm:"uniqueIndex;not null"     json:"email"`
	Profiles []Profile `gorm:"foreignKey:UserID"        json:"profiles,omitempty"`
}

type Profile struct {
	ID        uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint   `gorm:"not null;index"           json:"userId"`
	Name      string `gorm:"not null"                 json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

type WatchHistory struct {
	ID              uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	ProfileID       uint      `gorm:"not null;index"           json:"profileId"`
	MediaPath       string    `gorm:"not null"                 json:"mediaPath"`
	ProgressSeconds int       `json:"progressSeconds"`
	TotalDuration   int       `json:"totalDuration"`
	LastWatched     time.Time `json:"lastWatched"`
}

type Watchlist struct {
	ID        uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	ProfileID uint   `gorm:"not null;index"           json:"profileId"`
	MediaPath string `gorm:"not null"                 json:"mediaPath"`
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
	if err := db.AutoMigrate(&User{}, &Profile{}, &WatchHistory{}, &Watchlist{}); err != nil {
		log.Fatalf("migration failed: %v", err)
	}
}
