package telemetry

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"gorm.io/gorm"
)

const gormSpanKey = "otel:span"

type GormPlugin struct{}

func NewGormPlugin() *GormPlugin { return &GormPlugin{} }

func (p *GormPlugin) Name() string { return "otel:gorm" }

func (p *GormPlugin) Initialize(db *gorm.DB) error {
	cb := db.Callback()
	cb.Query().Before("gorm:query").Register("otel:before_query", p.before("gorm.query"))
	cb.Query().After("gorm:query").Register("otel:after_query", p.after)
	cb.Create().Before("gorm:create").Register("otel:before_create", p.before("gorm.create"))
	cb.Create().After("gorm:create").Register("otel:after_create", p.after)
	cb.Update().Before("gorm:update").Register("otel:before_update", p.before("gorm.update"))
	cb.Update().After("gorm:update").Register("otel:after_update", p.after)
	cb.Delete().Before("gorm:delete").Register("otel:before_delete", p.before("gorm.delete"))
	cb.Delete().After("gorm:delete").Register("otel:after_delete", p.after)
	cb.Row().Before("gorm:row").Register("otel:before_row", p.before("gorm.row"))
	cb.Row().After("gorm:row").Register("otel:after_row", p.after)
	return nil
}

func (p *GormPlugin) before(op string) func(*gorm.DB) {
	return func(db *gorm.DB) {
		if db.Statement == nil || db.Statement.Context == nil {
			return
		}
		_, span := otel.Tracer("gorm").Start(db.Statement.Context, op)
		db.InstanceSet(gormSpanKey, span)
	}
}

func (p *GormPlugin) after(db *gorm.DB) {
	val, ok := db.InstanceGet(gormSpanKey)
	if !ok {
		return
	}
	span, ok := val.(trace.Span)
	if !ok {
		return
	}
	defer span.End()
	if db.Statement != nil {
		if db.Statement.Table != "" {
			span.SetAttributes(attribute.String("db.sql.table", db.Statement.Table))
		}
		if sql := db.Statement.SQL.String(); sql != "" {
			span.SetAttributes(attribute.String("db.statement", sql))
		}
	}
	if db.Error != nil && db.Error != gorm.ErrRecordNotFound {
		span.RecordError(db.Error)
		span.SetStatus(codes.Error, db.Error.Error())
	}
}
