<?php declare(strict_types=1);

namespace Shopware\Core\Checkout\Promotion\Cart\Discount\Filter;

use Shopware\Core\Checkout\Promotion\Cart\Discount\DiscountPackageCollection;

interface FilterSorterInterface
{
    public function getKey(): string;

    public function sort(DiscountPackageCollection $packages): DiscountPackageCollection;
}
