require("dotenv").config();

module.exports = {
  //configuracion de la db
  username: process.env.DB_USERNAME || "root",
  password: process.env.DB_PASSWORD || null,
  database: process.env.DB_DATABASE || "apispree",
  host: process.env.DB_HOST || "127.0.0.1",
  port: process.env.DB_PORT || 3306,  
  dialect: process.env.DB_DIALECT || "mysql",

  // Configuración de pooling de conexiones
  pool: {
    max: 5, // Máximo de conexiones
    min: 0, // Mínimo de conexiones
    acquire: 30000, // Tiempo máximo para adquirir una conexión
    idle: 10000, // Tiempo máximo de inactividad para una conexión
  },

  //Configurar seeders
  seederStorage: "sequelize",
  seederStorageTableName: "seeds",

  //Configuracion de Migrations
  migrationStorage: "sequelize",
  migrationStorageTableName: "migrations",
};
