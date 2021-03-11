<?php declare(strict_types=1);

namespace Shopware\Core\System\Language\Command;

use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Driver\Exception as DoctrineDriverException;
use Doctrine\DBAL\Exception;
use InvalidArgumentException;
use Shopware\Core\Defaults;
use Shopware\Core\Framework\Api\Context\SystemSource;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepositoryInterface;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Sorting\FieldSorting;
use Shopware\Core\Framework\Uuid\Uuid;
use Shopware\Core\System\Language\LanguageDefinition;
use Shopware\Core\System\Language\LanguageEntity;
use Shopware\Core\System\Locale\LocaleEntity;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Question\ChoiceQuestion;
use Symfony\Component\Console\Question\ConfirmationQuestion;

class LanguageChangeDefaultCommand extends Command
{
    /**
     * @var EntityRepositoryInterface
     */
    private EntityRepositoryInterface $localeRepository;
    /**
     * @var EntityRepositoryInterface
     */
    private EntityRepositoryInterface $languageRepository;
    /**
     * @var Connection
     */
    private Connection $connection;

    /**
     * LanguageChangeDefaultCommand constructor.
     * @param EntityRepositoryInterface $localeRepository
     * @param EntityRepositoryInterface $languageRepository
     * @param Connection $connection
     */
    public function __construct(
        EntityRepositoryInterface $localeRepository,
        EntityRepositoryInterface $languageRepository,
        Connection $connection
    )
    {
        parent::__construct();
        $this->localeRepository = $localeRepository;
        $this->languageRepository = $languageRepository;
        $this->connection = $connection;
    }

    protected static $defaultName = 'language:change-default';

    protected function configure(): void
    {
        $this
            ->setDescription('Change the system default language')
            ->addArgument('locale', InputArgument::REQUIRED, 'the locale for the new system default language');
    }

    /**
     * @param InputInterface $input
     * @param OutputInterface $output
     */
    protected function interact(InputInterface $input, OutputInterface $output): void
    {
        $helper = $this->getHelper('question');

        if (!$input->getArgument('locale')) {
            $localeList = $this->getLocales();

            $question = new ChoiceQuestion('Please choose a language?', array_keys($localeList) );
            $localeLang = $helper->ask($input, $output, $question);

            if( count($localeList[$localeLang]) > 0 )
            {
                $question = new ChoiceQuestion('Please choose a language code?', $localeList[$localeLang] );
                $locale = $helper->ask($input, $output, $question);
            }
            else{
                $locale = array_shift($localeList[$localeLang]);
            }

            $input->setArgument('locale', $locale);
        }
    }

    private function getLocales() : array
    {
        $context = new Context(new SystemSource());
        /** @var LocaleEntity[] $locales */
        $locales = $this->localeRepository->search(
            (new Criteria())
                ->addAssociation('translations')
                ->addSorting(new FieldSorting('translations.name')),
            $context
        )->getEntities();
        $localeList = [];

        foreach($locales as $locale)
        {
            if( !array_key_exists($locale->getName(), $localeList) ) {
                $localeList[$locale->getName()] = [];
            }
            $localeList[$locale->getName()][] = $locale->getCode();
        }

        return $localeList;
    }

    /**
     * @param InputInterface $input
     * @param OutputInterface $output
     * @return int
     * @throws DoctrineDriverException
     * @throws Exception
     */
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        if($input->isInteractive()) {
            $helper = $this->getHelper('question');
            $question = new ConfirmationQuestion("Are you sure you want to change the system default language?\nLoose of data is possible! (yes/no) [yes]", true);
            if(!$helper->ask($input, $output, $question)) {
                return 0;
            }
        }
        $localeCode = $input->getArgument('locale');
        if(empty($localeCode)) {
            throw new InvalidArgumentException('argument locale shouldn\'t be empty');
        }
        $context = new Context(new SystemSource());

        $newLocale = $this->localeRepository->search(
            (new Criteria())
                ->addFilter(new EqualsFilter('code', $localeCode))
                ->addAssociation('translations'),
            $context
        )->first();
        if(!$newLocale instanceof LocaleEntity) {
            $output->writeln('<error>argument locale isn\'t a valid locale code</error>');
            return 1;
        }

        // if $currentDefaultLanguage is null there are more issues then we can solve
        /** @var LanguageEntity $currentDefaultLanguage */
        $currentDefaultLanguage = $this->languageRepository->search(
            (new Criteria([Defaults::LANGUAGE_SYSTEM]))
                ->addAssociation('locale'),
            $context
        )->first();

        $currentLocaleId = $currentDefaultLanguage->getLocaleId();
        $currentLocale = $currentDefaultLanguage->getLocale();
        if(!$currentLocale) {
            $output->writeln('<error>couldn\'t find current locale</error>');
            return 1;
        }
        $newDefaultLocaleId = $newLocale->getId();

        // locales match -> do nothing.
        if ($currentLocaleId === $newDefaultLocaleId) {
            $output->writeln(sprintf('<comment>nothing todo %s is already the system default language</comment>', $localeCode));
            return 0;
        }

        $newDefaultLanguageId = $this->languageRepository->searchIds(
            (new Criteria())
                ->addFilter(new EqualsFilter('localeId', $newDefaultLocaleId)),
            $context
        )->firstId();


        if (!$newDefaultLanguageId) {
            $newDefaultLanguageId = $this->createNewLanguageEntry($newLocale, $context);
        }

        $this->swapDefaultLanguageId($newDefaultLanguageId);

        $output->writeln(sprintf('<info>system default language changed to %s</info>', $newLocale->getCode()));

        return 0;
    }

    private function createNewLanguageEntry(LocaleEntity $locale, Context $context): string
    {
        $ids = $this->languageRepository->create([[
            'localeId' => $locale->getId(),
            'name' => $locale->getTranslation('name'),
            'translationCodeId' => $locale->getId()
        ]], $context)
            ->getPrimaryKeys(LanguageDefinition::ENTITY_NAME);
        return array_shift($ids);
    }

    /**
     * @param string $newLanguageId
     * @throws DoctrineDriverException
     * @throws Exception
     */
    private function swapDefaultLanguageId(string $newLanguageId): void
    {
        $this->connection->executeStatement('SET foreign_key_checks = 0;');
        $stmt = $this->connection->prepare(
            'UPDATE language
             SET id = :newId
             WHERE id = :oldId'
        );

        $tmpId = Uuid::randomBytes();

        // assign new uuid to old DEFAULT
        $stmt->execute([
            'newId' => $tmpId,
            'oldId' => Uuid::fromHexToBytes(Defaults::LANGUAGE_SYSTEM),
        ]);

        // change id to DEFAULT
        $stmt->execute([
            'newId' => Uuid::fromHexToBytes(Defaults::LANGUAGE_SYSTEM),
            'oldId' => Uuid::fromHexToBytes($newLanguageId),
        ]);

        $stmt->execute([
            'newId' => Uuid::fromHexToBytes($newLanguageId),
            'oldId' => $tmpId,
        ]);
        $this->connection->executeStatement('SET foreign_key_checks = 1;');
    }
}
