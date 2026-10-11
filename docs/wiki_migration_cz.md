# Migrace dat

Pro převod autentizačních účtů z **jPremium** nebo **MaxAuth BETA (0.9.x a starší)** do MaxAuth 1.0.0 a novějšího použij samostatný **MaxAuth Migration Tool**. Serverový plugin staré řádky sám neimportuje.

Veřejná adresa této stránky je [Data Migration](https://github.com/djnejk/MaxAuth_public/wiki/Data-Migration).

## Podporované migrační cesty

| Zdroj | Běžná zdrojová tabulka | Cíl |
| --- | --- | --- |
| jPremium | `user_profiles` | `<storageTablePrefix>accounts`, `<storageTablePrefix>identities`, `<storageTablePrefix>metadata` |
| MaxAuth BETA | `maxauth_users` nebo vlastní staré `storageTableName` | `<storageTablePrefix>accounts`, `<storageTablePrefix>identities`, `<storageTablePrefix>metadata` |

Nástroj podporuje SQLite, MySQL, MariaDB a PostgreSQL jako zdroj i přímý cíl. Umí také exportovat samostatný SQL skript pro SQLite, MySQL/MariaDB nebo PostgreSQL.

Při výchozím `storageTablePrefix: 'maxauth_'` vzniknou tabulky:

- `maxauth_accounts`
- `maxauth_identities`
- `maxauth_metadata`

Prefix zvolený v nástroji musí být stejný jako `storageTablePrefix` v nové proxy konfiguraci MaxAuth. Smí obsahovat pouze ASCII písmena, čísla a podtržítka a může mít nejvýše 36 znaků.

## Co nástroj zachová

Z každého kompatibilního starého řádku se zachová nickname, hash hesla, e-mailová adresa, 2FA verification token, expirace session, poslední server, první a poslední adresa a časy prvního a posledního připojení.

Práce s identitou se záměrně mění:

- Každý importovaný účet začíná jako `MIGRATED`, který má úplně stejná autentizační oprávnění jako `CRACKED`.
- Staré `premiumId` se uloží jen jako **čekající Mojang claim**, nikdy jako důvěryhodná identita.
- Claim se stane důvěryhodným až po reconnectu, který v aktuálním online-mode flow prokáže přesně stejnou Mojang identitu.
- Zastaralý nebo chybný claim se odstraní, pokud nickname už nepatří dané Mojang identitě, a hráč pokračuje cracked flow.
- `lastServerRedirectionEnabled` začíná jako `false`; hráč si jej může později zapnout přes `/maxauth lastserver`, pokud je povoleno `allowPlayerLastServerRedirection`.
- Z UUID ani nicku se neodhaduje Floodgate identita. Bedrock identita vznikne až po aktuálním Floodgate API proofu.
- Poškozené nebo nulové backend UUID se deterministicky nahradí použitelným UUID a objeví se v preview mezi UUID opravami.

Hash hesla se kopíruje bez oslabení a bez okamžitého rehashe. MaxAuth podporované legacy hashe ověří a při zapnutém `rehashPasswordWhenUsingDifferentAlgorithm` je po příštím úspěšném přihlášení heslem převede na aktuálně nastavený algoritmus.

## Před migrací

1. Vypni všechny proxy a backend instance, které mohou zapisovat autentizační data.
2. Zálohuj celou starou databázi i obě pluginové složky.
3. Obnov zálohu v odděleném staging prostředí.
4. Zapiš si počet starých řádků, typ databáze, název tabulky a použitý UUID režim MaxAuth.
5. Připrav novou konfiguraci MaxAuth. Nech `storageTableName: ''` a nastav `storageTablePrefix` na prefix, který vybereš v nástroji.
6. Staging proxy nezpřístupňuj veřejným hráčům.

Nikdy neprováděj první migrační pokus nad jedinou kopií produkční databáze.

## Použití MaxAuth Migration Tool

1. Spusť **MaxAuth Migration Tool**.
2. Jako zdroj vyber `jPremium` nebo `MaxAuth BETA`.
3. Vyber typ zdrojové databáze a vyplň připojení, případně zvol SQLite soubor.
4. Klikni na **Test connection and load tables**.
5. Vyber kompatibilní legacy tabulku. Nástroj zvýrazní `user_profiles` pro jPremium a `maxauth_users` nebo jinou MaxAuth tabulku pro MaxAuth BETA.
6. Pro přímou migraci zvol **Write to database**, pro kontrolovaný ruční import zvol **Export SQL script**.
7. Zadej přesně stejný prefix, jaký používá nové `storageTablePrefix`. Výchozí je `maxauth_`.
8. Pokud je cíl v jiné databázi, zapni **Migrate to a different server or database** a cílové připojení otestuj.
9. Klikni na **Build preview**.
10. Zkontroluj všechny počty a rozbal **Skipped rows and UUID repairs**. Nepokračuj, dokud nerozumíš každému přeskočenému řádku a změně UUID.
11. Potvrď, že existuje úplná záloha a všechny proxy jsou vypnuté.
12. Spusť migraci nebo ulož SQL skript.

Legacy tabulka je pouze pro čtení: nástroj ji nepřejmenuje ani nesmaže. Přímé vložení účtů a completion marker se zapisují transakčně. MySQL a MariaDB automaticky commitují DDL, takže po rollbacku importu mohou zůstat prázdné cílové tabulky; obnov nebo vyčisti pouze neúspěšný **cíl**, nikdy jediný legacy zdroj.

### Upozornění k SQL exportu

SQL export nemůže zkontrolovat databázi, ve které bude skript později spuštěn. Použij ho pouze nad prázdným nebo kompatibilním MaxAuth cílem. Před spuštěním zkontroluj zvolený dialekt, prefix, seznam přeskočených řádků a opravených UUID.

## Význam preview

- **Source rows**: řádky načtené ze zvolené legacy tabulky.
- **Will migrate**: řádky, které lze vložit do cíle.
- **Will skip**: neplatné nicky nebo kolize normalizovaného nicku, backend UUID, trusted Mojang identity či pending Mojang claimu.
- **UUID repairs**: poškozená nebo nulová backend UUID nahrazená deterministickými použitelnými UUID.
- **Pending proof**: stará premium ID, která vyžadují nový Mojang online-mode proof.

Přeskočené řádky se nikdy tiše nesloučí. Oprav zdroj nebo migrační plán offline, obnov čistou zálohu cíle a preview zopakuj. Pokud se backend UUID změnilo, převeď zvlášť permissions, ranky, inventáře, statistiky a playerdata v pluginech, které je vlastní.

## Ověření před produkcí

1. Ověř, že počet cílových účtů odpovídá **Will migrate**, ne nutně **Source rows**, pokud preview něco přeskočilo.
2. Nastav proxy `storageTablePrefix` na migrovaný prefix a ponech `storageTableName: ''`.
3. Spusť nový MaxAuth proxy i backendy pouze ve stagingu.
4. Spusť `/maxauth authaudit`; musí projít bez chyby integrity.
5. Spusť `/maxauth pending list` a porovnej výsledek s **Pending proof**.
6. Otestuj alespoň jeden migrovaný cracked účet se starým heslem.
7. Otestuj migrovaný premium účet v oficiálním klientovi a ověř, že se stane trusted až po online proofu.
8. Otestuj účet se zastaralým starým premium ID a ověř, že vyžaduje cracked přihlášení místo premium přístupu.
9. Otestuj každé opravené UUID a před produkcí převeď jeho externí permissions/playerdata mapping.
10. Samostatně otestuj nové i existující Floodgate hráče; migrace Floodgate identity nevytváří.
11. Pokud byly používány, otestuj expiraci session, 2FA, obnovu hesla e-mailem a last-server chování.

Síť neotvírej, pokud preview obsahuje nevysvětlené přeskočené řádky, `/maxauth authaudit` selže, očekávaný hash hesla nelze ověřit nebo chybí externí data svázaná s UUID.

## Odstranění legacy upozornění

MaxAuth varuje, když `storageTableName` není prázdné nebo když aktivní databáze stále obsahuje přesnou jPremium tabulku `user_profiles`.

Po úspěšném staging ověření a finálním přijetí migrace:

1. Zachovej neměnnou zálohu stavu před migrací.
2. Nastav `storageTableName: ''`.
3. Pokud je `user_profiles` v aktivní cílové databázi, archivuj ji mimo tuto databázi nebo ji přejmenuj/odstraň až po ověření, že externí zálohu lze obnovit.
4. Restartuj MaxAuth a ověř, že už nevypisuje legacy warning.
5. Znovu spusť `/maxauth authaudit`.

Nikdy nemaž ani nepřejmenovávej jedinou kopii legacy dat jen kvůli skrytí warningu.

## Rollback

Pokud ověření selže, vypni všechny writery a obnov databázi před migrací, pluginové složky a předchozí proxy/backend JARy jako jeden koordinovaný celek. Nekombinuj obnovená legacy data s částečně naplněným novým cílem. Pro další staging pokus zachovej preview nástroje, seznam přeskočených řádků, mapování opravených UUID, SQL export i logy.
