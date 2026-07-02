package store

import (
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Media holds enriched metadata for a media item keyed by its file path.
type Media struct {
	ID          uint     `gorm:"primaryKey;autoIncrement"   json:"id"`
	MediaPath   string   `gorm:"uniqueIndex;not null"       json:"mediaPath"`
	Title       string   `gorm:"not null"                   json:"title"`
	Description string   `gorm:"type:text"                  json:"description"`
	Genre       string   `json:"genre"`
	ReleaseYear int      `json:"releaseYear"`
	Director    string   `json:"director"`
	Cast        string   `gorm:"type:text"                  json:"cast"`
	PosterURL   string   `json:"posterUrl"`
	BackdropURL string   `json:"backdropUrl"`
	Rating      float32  `json:"rating"`
	Language    string   `json:"language"`
	TMDBId      int      `gorm:"column:tmdb_id;index"       json:"tmdbId"`
	MediaType   string   `gorm:"default:'movie'"            json:"mediaType"` // "movie" | "tv"
	Tags        []Tag    `gorm:"foreignKey:MediaID"         json:"tags,omitempty"`
}

// Tag is a free-form label attached to a Media entry.
type Tag struct {
	ID      uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	MediaID uint   `gorm:"not null;index"           json:"mediaId"`
	Name    string `gorm:"not null"                 json:"name"`
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
	if err := db.AutoMigrate(&Media{}, &Tag{}); err != nil {
		log.Fatalf("migration failed: %v", err)
	}
}
