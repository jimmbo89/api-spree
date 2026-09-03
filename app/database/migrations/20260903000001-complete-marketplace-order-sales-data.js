'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const orderColumns = {
      sale_date: { type: Sequelize.DATE, allowNull: true },
      pack_id: { type: Sequelize.STRING(100), allowNull: true },
      shipment_id: { type: Sequelize.STRING(100), allowNull: true },
      shipping_status: { type: Sequelize.STRING(50), allowNull: true },
      shipping_substatus: { type: Sequelize.STRING(100), allowNull: true },
      shipped_at: { type: Sequelize.DATE, allowNull: true },
      delivered_at: { type: Sequelize.DATE, allowNull: true },
      cancelled_at: { type: Sequelize.DATE, allowNull: true },
      returned_at: { type: Sequelize.DATE, allowNull: true },
      managed_by_spree: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      new_order_notified_at: { type: Sequelize.DATE, allowNull: true }
    };
    const itemColumns = {
      title: { type: Sequelize.STRING(500), allowNull: true },
      user_product_id: { type: Sequelize.STRING(100), allowNull: true },
      marketplace_attributes: { type: Sequelize.JSON, allowNull: true },
      managed_by_spree: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    };

    for (const [name, definition] of Object.entries(orderColumns)) {
      await queryInterface.addColumn('marketplace_orders', name, definition);
    }
    for (const [name, definition] of Object.entries(itemColumns)) {
      await queryInterface.addColumn('marketplace_order_items', name, definition);
    }

    await queryInterface.addIndex('marketplace_orders', ['sale_date'], { name: 'idx_marketplace_orders_sale_date' });
    await queryInterface.addIndex('marketplace_orders', ['pack_id'], { name: 'idx_marketplace_orders_pack_id' });
    await queryInterface.addIndex('marketplace_orders', ['shipment_id'], { name: 'idx_marketplace_orders_shipment_id' });
    await queryInterface.addIndex('marketplace_orders', ['managed_by_spree'], { name: 'idx_marketplace_orders_managed_by_spree' });
    await queryInterface.addIndex('marketplace_orders', ['new_order_notified_at'], { name: 'idx_marketplace_orders_new_order_notified_at' });

    // Las órdenes existentes no deben emitir una notificación retroactiva.
    await queryInterface.sequelize.query(
      'UPDATE marketplace_orders SET new_order_notified_at = COALESCE(new_order_notified_at, createdAt)'
    );

    // Backfill de los identificadores básicos disponibles en el payload histórico.
    await queryInterface.sequelize.query(`
      UPDATE marketplace_orders
      SET sale_date = COALESCE(sale_date, JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.order.date_created'))),
          pack_id = COALESCE(pack_id, JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.order.pack_id'))),
          shipment_id = COALESCE(
            shipment_id,
            JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.shipment.id')),
            JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.order.shipping.id'))
          )
      WHERE raw_payload IS NOT NULL
    `);

    const orders = await queryInterface.sequelize.query(
      `SELECT id, marketplace, marketplace_credential_id, company_id, branch_id, user_id, raw_payload
       FROM marketplace_orders WHERE raw_payload IS NOT NULL`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    for (const order of orders) {
      const raw = typeof order.raw_payload === 'string' ? JSON.parse(order.raw_payload) : order.raw_payload;
      const rawOrder = raw?.order || {};
      const rawItems = Array.isArray(rawOrder.order_items) ? rawOrder.order_items : [];
      if (!rawItems.length) continue;

      const credentialRows = await queryInterface.sequelize.query(
        'SELECT marketplace_id FROM marketplace_credentials WHERE id = :credentialId LIMIT 1',
        { replacements: { credentialId: order.marketplace_credential_id }, type: queryInterface.sequelize.QueryTypes.SELECT }
      );
      const marketplaceId = credentialRows[0]?.marketplace_id;
      let allManaged = true;
      for (const rawItem of rawItems) {
        const listingId = rawItem?.item?.id || rawItem?.item_id || rawItem?.id || null;
        const marketplaceItemId = rawItem?.id ? String(rawItem.id) : null;
        if (!listingId) { allManaged = false; continue; }

        const links = marketplaceId ? await queryInterface.sequelize.query(
          `SELECT product_id, company_id, branch_id, user_id
           FROM product_marketplace_links
           WHERE marketplace_id = :marketplaceId AND external_id = :listingId
             AND (credential_id = :credentialId OR credential_id IS NULL)
           ORDER BY credential_id IS NULL, updatedAt DESC, id DESC LIMIT 1`,
          { replacements: { marketplaceId, listingId: String(listingId), credentialId: order.marketplace_credential_id }, type: queryInterface.sequelize.QueryTypes.SELECT }
        ) : [];
        const link = links[0] || null;
        allManaged = allManaged && Boolean(link);
        const existing = await queryInterface.sequelize.query(
          `SELECT id FROM marketplace_order_items
           WHERE order_id = :orderId AND marketplace_item_id <=> :marketplaceItemId AND listing_id <=> :listingId
           LIMIT 1`,
          { replacements: { orderId: order.id, marketplaceItemId, listingId: String(listingId) }, type: queryInterface.sequelize.QueryTypes.SELECT }
        );
        const values = {
          orderId: order.id,
          marketplaceItemId,
          listingId: String(listingId),
          sku: rawItem?.item?.seller_custom_field || rawItem?.item?.seller_sku || rawItem?.seller_custom_field || rawItem?.seller_sku || null,
          title: rawItem?.item?.title || rawItem?.title || null,
          userProductId: rawItem?.item?.user_product_id || rawItem?.user_product_id || null,
          attributes: JSON.stringify(rawItem?.item?.variation_attributes || rawItem?.variation_attributes || rawItem?.item?.attributes || null),
          productId: link?.product_id || null,
          companyId: link?.company_id || order.company_id || null,
          branchId: link?.branch_id || order.branch_id || null,
          userId: link?.user_id || order.user_id || null,
          quantity: Number(rawItem?.quantity || 1),
          unitPrice: Number(rawItem?.unit_price || 0),
          totalPrice: Number(rawItem?.unit_price || 0) * Number(rawItem?.quantity || 1),
          managed: Boolean(link)
        };
        if (existing[0]) {
          await queryInterface.sequelize.query(
            `UPDATE marketplace_order_items SET title=:title, user_product_id=:userProductId,
             marketplace_attributes=:attributes, product_id=:productId, company_id=:companyId,
             branch_id=:branchId, user_id=:userId, quantity=:quantity, unit_price=:unitPrice,
             total_price=:totalPrice, managed_by_spree=:managed WHERE id=:id`,
            { replacements: { ...values, id: existing[0].id } }
          );
        } else {
          await queryInterface.sequelize.query(
            `INSERT INTO marketplace_order_items
             (order_id, marketplace_item_id, listing_id, sku, title, user_product_id, marketplace_attributes,
              product_id, company_id, branch_id, user_id, quantity, unit_price, total_price, managed_by_spree, createdAt, updatedAt)
             VALUES (:orderId, :marketplaceItemId, :listingId, :sku, :title, :userProductId, :attributes,
              :productId, :companyId, :branchId, :userId, :quantity, :unitPrice, :totalPrice, :managed, NOW(), NOW())`,
            { replacements: values }
          );
        }
      }
      await queryInterface.sequelize.query(
        'UPDATE marketplace_orders SET managed_by_spree = :managed WHERE id = :id',
        { replacements: { managed: allManaged, id: order.id } }
      );
    }
  },

  async down(queryInterface) {
    for (const name of ['idx_marketplace_orders_new_order_notified_at', 'idx_marketplace_orders_managed_by_spree', 'idx_marketplace_orders_shipment_id', 'idx_marketplace_orders_pack_id', 'idx_marketplace_orders_sale_date']) {
      await queryInterface.removeIndex('marketplace_orders', name);
    }
    for (const name of ['new_order_notified_at', 'managed_by_spree', 'returned_at', 'cancelled_at', 'delivered_at', 'shipped_at', 'shipping_substatus', 'shipping_status', 'shipment_id', 'pack_id', 'sale_date']) {
      await queryInterface.removeColumn('marketplace_orders', name);
    }
    for (const name of ['managed_by_spree', 'marketplace_attributes', 'user_product_id', 'title']) {
      await queryInterface.removeColumn('marketplace_order_items', name);
    }
  }
};
