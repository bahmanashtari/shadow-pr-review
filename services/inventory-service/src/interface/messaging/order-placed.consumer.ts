import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { StockService } from '../../application/stock.service';

interface OrderPlacedPayload {
  orderId: string;
  items: { sku: string; quantity: number }[];
}

@Controller()
export class OrderPlacedConsumer {
  constructor(private readonly stock: StockService) {}

  @EventPattern('order.placed')
  async handle(@Payload() event: OrderPlacedPayload): Promise<void> {
    for (const item of event.items) {
      await this.stock.decrement(item.sku, item.quantity);
    }
  }
}
